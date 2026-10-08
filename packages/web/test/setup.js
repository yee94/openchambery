import request from 'supertest';

// Supertest 7.2 starts wildcard listeners but builds IPv4-only request URLs.
// On macOS an unrelated IPv4 listener can occupy the same port as that IPv6
// listener. Match the actual address family so tests cannot hit a running app.
const serverAddress = request.Test.prototype.serverAddress;
request.Test.prototype.serverAddress = function (server, pathname) {
  const result = serverAddress.call(this, server, pathname);
  const address = server.address();
  if (!address || typeof address === 'string' || address.family !== 'IPv6') return result;
  const url = new URL(result);
  url.hostname = `[${address.address === '::' ? '::1' : address.address}]`;
  return url.toString();
};
