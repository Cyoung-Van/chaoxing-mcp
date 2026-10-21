export class ClientFault extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClientFault';
    this.code = code;
  }
}

export function describeError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'OPERATION_FAILED';
  const message = String(error?.message ?? error).replace(/https?:\/\/[^\s<>"']+/g, raw => {
    try { const address = new URL(raw); return address.origin + address.pathname; }
    catch { return '[address]'; }
  }).slice(0, 400);
  return { code, message };
}
