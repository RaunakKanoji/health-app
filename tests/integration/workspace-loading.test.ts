import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { action, newEpisode, signIn, testApplication } from '../helpers.ts';
import type { Episode, User } from '../../packages/contracts/src/careloop.ts';

describe('bounded workspace loading with current record authorization', () => {
  let context: Awaited<ReturnType<typeof testApplication>>;
  let clinicianCookie: string;
  let clinician: User;
  let patient: User;
  let receiver: User;

  beforeAll(async () => {
    context = await testApplication();
    clinicianCookie = await signIn(context.app, 'clinician');
    clinician = (await context.app.service.user('user-clinician'))!;
    patient = (await context.app.service.user('user-patient'))!;
    receiver = (await context.app.service.user('user-receiver'))!;
  });
  afterAll(async () => { await context?.close(); });

  async function measured<T>(read: () => Promise<T>) {
    const query = vi.spyOn(context.app.db.pool, 'query');
    try {
      const result = await read();
      return { result, queries: query.mock.calls.length };
    } finally { query.mockRestore(); }
  }

  it('does not add database round trips when the visible episode count grows', async () => {
    const read = (actor: User) => measured(() => context.app.service.workspace(actor));
    const staffBefore = await read(clinician);
    const patientBefore = await read(patient);
    const added = 12;
    for (let i = 0; i < added; i++) await newEpisode(context.app, clinicianCookie);
    const staffAfter = await read(clinician);
    const patientAfter = await read(patient);

    for (const [before, after] of [[staffBefore, staffAfter], [patientBefore, patientAfter]] as const) {
      expect(after.result.episodes).toHaveLength(before.result.episodes.length + added);
      expect(after.result.metrics.totalResults).toBe(after.result.episodes.length);
      expect(after.queries).toBe(before.queries);
      expect(after.queries).toBeLessThanOrEqual(4);
    }
    expect(staffAfter.result.users.length).toBeGreaterThan(0);
    expect(staffAfter.result.users.every(user => user.organizationId === clinician.organizationId && user.role !== 'patient' && user.accountStatus === 'active')).toBe(true);
    expect(patientAfter.result.users).toEqual([]);
    expect(patientAfter.result.organizations.map(organization => organization.id)).toEqual([patient.organizationId]);
  });

  it('uses the latest consent sequence and preserves the patient response projection', async () => {
    const episode = await newEpisode(context.app, clinicianCookie);
    const privateNote = 'Private staff-only review for the workspace loading regression';
    const explanation = 'The care team has reviewed this synthetic result.';
    const response = await action(context.app, clinicianCookie, episode, {
      type: 'review', note: privateNote, patientExplanation: explanation,
      urgency: 'ROUTINE', dueAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(response.statusCode).toBe(200);
    // The later sequence deliberately has an earlier timestamp. Receipt order is authoritative.
    await context.app.db.pool.query(`INSERT INTO patient_consents(id,organization_id,patient_id,purpose,granted,actor_id,created_at)
      VALUES($1,$3,$4,'optional_communications',true,$5,'2030-01-01'),
            ($2,$3,$4,'optional_communications',false,$5,'2020-01-01')`,
    [randomUUID(), randomUUID(), patient.organizationId, patient.patientId, patient.id]);

    const workspace = await context.app.service.workspace(patient);
    const own = workspace.episodes.find(value => value.id === episode.id)!;
    expect(own).toBeDefined();
    expect(workspace.episodes.every(value => value.patient.id === patient.patientId && !value.patient.communicationConsent)).toBe(true);
    expect(own.result.summary).toBe(explanation);
    expect(own.result.sourceId).toBe('');
    expect(own.review?.note).toBeUndefined();
    expect(own.events).toEqual([]);
    expect(own.tasks).toEqual([]);
    expect(own.evidence).toEqual([]);
    expect(JSON.stringify(workspace)).not.toContain(privateNote);
    expect((await context.app.service.getEpisode(clinician, episode.id)).review?.note).toBe(privateNote);
  });

  it.each([
    { change: "UPDATE users SET account_status='suspended' WHERE id='user-clinician'", restore: "UPDATE users SET account_status='active' WHERE id='user-clinician'", label: 'account suspension' },
    { change: "UPDATE clinician_profiles SET verification_status='pending' WHERE user_id='user-clinician'", restore: "UPDATE clinician_profiles SET verification_status='approved' WHERE user_id='user-clinician'", label: 'clinician approval withdrawal' },
  ])('rechecks $label after the initial actor read', async ({ change, restore }) => {
    const original = context.app.service.user.bind(context.app.service);
    const read = vi.spyOn(context.app.service, 'user').mockImplementationOnce(async id => {
      const current = await original(id);
      await context.app.db.pool.query(change);
      return current;
    });
    try {
      expect(await context.app.service.listEpisodes(clinician)).toEqual([]);
      await expect(context.app.service.listEpisodes(clinician)).rejects.toMatchObject({ status: 403 });
    } finally {
      read.mockRestore();
      await context.app.db.pool.query(restore);
    }
  });

  it('rejects a stale patient identity after its authoritative patient mapping changes', async () => {
    await context.app.db.pool.query("UPDATE users SET patient_id='patient-002' WHERE id=$1", [patient.id]);
    try { expect(await context.app.service.listEpisodes(patient)).toEqual([]); }
    finally { await context.app.db.pool.query('UPDATE users SET patient_id=$1 WHERE id=$2', [patient.patientId, patient.id]); }
  });

  it.each([
    { path: ['id'], value: 'episode-002', label: 'episode' },
    { path: ['organizationId'], value: 'org-other', label: 'organization' },
    { path: ['patient', 'id'], value: 'patient-002', label: 'patient' },
  ])('does not authorize a snapshot whose $label identity differs from its row', async ({ path, value }) => {
    const original = (await context.app.db.pool.query<{ snapshot: Episode }>("SELECT snapshot FROM care_episodes WHERE id='episode-001'")).rows[0]!.snapshot;
    const expectedIds = (await context.app.service.listEpisodes(clinician)).filter(episode => episode.id !== 'episode-001').map(episode => episode.id).sort();
    await context.app.db.pool.query("UPDATE care_episodes SET snapshot=jsonb_set(snapshot,$1::text[],$2::jsonb) WHERE id='episode-001'", [path, JSON.stringify(value)]);
    try {
      expect((await context.app.service.listEpisodes(clinician)).map(episode => episode.id).sort()).toEqual(expectedIds);
      expect((await context.app.service.listEpisodes(patient)).some(episode => episode.id === 'episode-001' || episode.patient.id !== patient.patientId)).toBe(false);
    } finally { await context.app.db.pool.query("UPDATE care_episodes SET snapshot=$1 WHERE id='episode-001'", [JSON.stringify(original)]); }
  });

  it('still requires the receiver referral in addition to an active access grant', async () => {
    expect((await context.app.service.listEpisodes(receiver)).some(episode => episode.id === 'episode-005')).toBe(true);
    const original = (await context.app.db.pool.query<{ snapshot: Episode }>("SELECT snapshot FROM care_episodes WHERE id='episode-005'")).rows[0]!.snapshot;
    await context.app.db.pool.query("UPDATE care_episodes SET snapshot=jsonb_set(snapshot,'{referrals}','[]') WHERE id='episode-005'");
    try { expect((await context.app.service.listEpisodes(receiver)).some(episode => episode.id === 'episode-005')).toBe(false); }
    finally { await context.app.db.pool.query("UPDATE care_episodes SET snapshot=$1 WHERE id='episode-005'", [JSON.stringify(original)]); }
  });
});
