// Node stand-in for the "cloudflare:workers" module so tests can import the Worker entry point.
export class DurableObject {
  constructor(
    protected ctx: unknown,
    protected env: unknown,
  ) {}
}
