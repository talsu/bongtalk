export const SESSION_COMPROMISED = 'auth.session.compromised';

export class SessionCompromisedEvent {
  constructor(
    public readonly userId: string,
    public readonly familyId: string,
    public readonly detectedAt: Date = new Date(),
  ) {}
}
