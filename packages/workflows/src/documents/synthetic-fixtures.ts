import {createHash} from 'node:crypto';

/** Versioned, entirely synthetic examples. These bytes alone may use the opt-in fixture scanner. */
export function syntheticPdf(lines:readonly string[],pageCount=1):Uint8Array {
 if(!Number.isInteger(pageCount)||pageCount<1||pageCount>100)throw new Error('Synthetic page count limit');
 const escape=(value:string)=>value.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)');
 const stream=lines.map((line,index)=>`BT /F1 10 Tf 40 ${790-index*23} Td (${escape(line)}) Tj ET`).join('\n');
 const objects=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  `<< /Type /Pages /Kids [${[3,...Array.from({length:pageCount-1},(_,i)=>i+6)].map(id=>`${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
 ];
 for(let page=1;page<pageCount;page++)objects.push(objects[2]!);
 let pdf='%PDF-1.4\n';const offsets=[0];
 objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
 for(const offset of offsets.slice(1))pdf+=`${String(offset).padStart(10,'0')} 00000 n \n`;
 pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return new Uint8Array(Buffer.from(pdf));
}
const examples={
 'cbc': ['SYNTHETIC CARELOOP DEMONSTRATION - NOT A REAL PATIENT','Complete blood count','Report date: 2026-10-01','Collection date: 2026-10-01','Laboratory: Synthetic Demonstration Laboratory','Specimen: Blood','Test | Result | Unit | Reference','Hemoglobin | 13.4 | g/dL | 12.0 - 16.0','White blood cells | 6.2 | 10^9/L | 4.0 - 11.0','Platelets | 235 | 10^9/L | 150 - 400'],
 'hba1c': ['SYNTHETIC CARELOOP DEMONSTRATION - NOT A REAL PATIENT','HbA1c laboratory report','Report date: 2026-10-01','Collection date: 2026-10-01','Laboratory: Synthetic Demonstration Laboratory','Method: HPLC','Specimen: Blood','Test | Result | Unit | Reference','HbA1c | 5.2000 | % | 4.0 - 5.6'],
 'hba1c-followup': ['SYNTHETIC CARELOOP DEMONSTRATION - NOT A REAL PATIENT','HbA1c laboratory report','Report date: 2026-11-01','Collection date: 2026-11-01','Laboratory: Synthetic Demonstration Laboratory','Method: HPLC','Specimen: Blood','Test | Result | Unit | Reference','HbA1c | 5.5000 | % | 4.0 - 5.6'],
 'lipids': ['SYNTHETIC CARELOOP DEMONSTRATION - NOT A REAL PATIENT','Lipid profile laboratory report','Report date: 2026-10-02','Laboratory: Synthetic Demonstration Laboratory','Specimen: Serum','Test | Result | Unit | Reference','Total cholesterol | 210 | mg/dL | 100 - 200','Triglycerides | 125 | mg/dL | 40 - 150'],
 'metabolic': ['SYNTHETIC CARELOOP DEMONSTRATION - NOT A REAL PATIENT','Basic metabolic panel laboratory report','Report date: 2026-10-03','Laboratory: Synthetic Demonstration Laboratory','Test | Result | Unit | Reference','Sodium | 140 | mmol/L | 135 - 145','Potassium | 4.1 | mmol/L | 3.5 - 5.1','Creatinine | 0.80 | mg/dL | 0.6 - 1.2'],
 'consultation': ['SYNTHETIC CARELOOP DEMONSTRATION - NOT A REAL PATIENT','Consultation summary','Report date: 2026-10-04','Provider: Synthetic Clinic','Impression: Routine review of the supplied synthetic records.','No diagnosis or treatment recommendation is made in this fixture.'],
 'prescription': ['SYNTHETIC CARELOOP DEMONSTRATION - NOT A REAL PATIENT','Historical prescription document','Report date: 2026-10-05','Provider: Synthetic Clinic','Medication: SYNTHETIC PLACEHOLDER - not a real medicine or instruction.','For software verification only; never use as a prescription.'],
 'ambiguous': ['SYNTHETIC CARELOOP DEMONSTRATION - NOT A REAL PATIENT','Laboratory report requiring manual review','Laboratory: Synthetic Demonstration Laboratory','Test | Result | Unit | Reference','Glucose | 1O5 | mg/dL | Not supplied','Unspecified measurement | <5 | Not supplied | Not supplied'],
} as const;
export type SyntheticDocumentFixtureName=keyof typeof examples;
export const syntheticDocumentFixtures=Object.fromEntries(Object.entries(examples).map(([name,lines])=>{
 const bytes=syntheticPdf(lines);return[name,{name,filename:`synthetic-${name}.pdf`,mimeType:'application/pdf' as const,bytes,sha256:createHash('sha256').update(bytes).digest('hex')}];
})) as Record<SyntheticDocumentFixtureName,{name:string;filename:string;mimeType:'application/pdf';bytes:Uint8Array;sha256:string}>;
export const syntheticFixtureChecksums=new Set(Object.values(syntheticDocumentFixtures).map(fixture=>fixture.sha256));
// Rasterized committed fixture: tests/fixtures/medical-documents/synthetic-scanned.png.
syntheticFixtureChecksums.add('4ee376dfb1e7596878ad4982999804eecdc5c72e7ea738888fd8428dd5400604');
