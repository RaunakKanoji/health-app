export type MessageEnvelope = { id:string; channel:'portal'|'email'|'sms'; content:string; simulatedFailure?:boolean };
export type DeliveryOutcome = { status:'DELIVERED'|'FAILED'; provider:'local-simulated-inbox'; errorCode?:'SIMULATED_PROVIDER_FAILURE' };
/** Providers report delivery only. Patient acknowledgement is never a provider outcome. */
export interface MessagingProvider { readonly simulated:boolean; deliver(message:MessageEnvelope):Promise<DeliveryOutcome> }
/** No network calls, addresses, phone numbers, or live credentials are accepted by this adapter. */
export class LocalSimulatedMessagingProvider implements MessagingProvider {
 readonly simulated=true;
 async deliver(message:MessageEnvelope):Promise<DeliveryOutcome>{
  return message.simulatedFailure?{status:'FAILED',provider:'local-simulated-inbox',errorCode:'SIMULATED_PROVIDER_FAILURE'}:{status:'DELIVERED',provider:'local-simulated-inbox'};
 }
}
export interface EmailProvider extends MessagingProvider { readonly channel:'email' }
export interface SmsProvider extends MessagingProvider { readonly channel:'sms' }
