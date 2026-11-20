// An error that carries the HTTP status to answer with. Anything else thrown
// while answering a request is a 500.
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
