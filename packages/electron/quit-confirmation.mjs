export const resolveQuitInterception = ({ platform, quitConfirmed, quitConfirmationPending }) => {
  if (platform !== 'darwin' || quitConfirmed) return 'continue';
  return quitConfirmationPending ? 'confirm' : 'prompt';
};
