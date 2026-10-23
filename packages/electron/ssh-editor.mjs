const SCHEMES = new Map([
  ['vscode', 'vscode'],
  ['vscode-insiders', 'vscode-insiders'],
  ['cursor', 'cursor'],
  ['windsurf', 'windsurf'],
  ['zed', 'zed'],
]);

export const sshEditorAppIds = () => [...SCHEMES.keys()];

export const buildSshEditorUrl = ({ appId, projectPath, ssh }) => {
  const scheme = SCHEMES.get(appId);
  if (!scheme) throw new Error('Unsupported SSH editor');
  if (typeof projectPath !== 'string' || !projectPath.startsWith('/') || /[\0\r\n]/.test(projectPath)) {
    throw new Error('An absolute remote project path is required');
  }
  let host = ssh.destination;
  let user;
  let port;
  const at = host.lastIndexOf('@');
  if (at >= 0) {
    user = host.slice(0, at);
    host = host.slice(at + 1);
  }
  for (let i = 0; i < ssh.args.length; i++) {
    const arg = ssh.args[i];
    const flag = arg.slice(0, 2);
    if (flag !== '-p' && flag !== '-l') {
      throw new Error('SSH_EDITOR_CONFIG_REQUIRED');
    }
    const value = arg.length > 2 ? arg.slice(2) : ssh.args[++i];
    if (flag === '-p') port ??= Number(value);
    else user ??= value;
  }
  if (!host || /[\s/?#\0]/.test(host) || host.startsWith('-') || (user !== undefined && (!user || /[\s/?#\0]/.test(user)))) {
    throw new Error('Invalid SSH destination');
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Invalid SSH port');
  }
  const remotePath = projectPath.split('/').map(encodeURIComponent).join('/');
  if (appId === 'zed') {
    const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `zed://ssh/${user ? `${encodeURIComponent(user)}@` : ''}${hostname}${port ? `:${port}` : ''}${remotePath}`;
  }
  // Remote-SSH's structured authority carries an explicit port without treating
  // host:port as an OpenSSH hostname. Bare aliases retain the user's SSH config.
  const authority = port !== undefined
    ? Buffer.from(JSON.stringify({ hostName: host, ...(user ? { user } : {}), port })).toString('hex')
    : encodeURIComponent(user ? `${user}@${host}` : host);
  return `${scheme}://vscode-remote/ssh-remote+${authority}${remotePath}?windowId=_blank`;
};
