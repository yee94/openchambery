export const createTunnelWiringRuntime = () => {
  const initialize = (_app, initialPort) => {
    let activePort = initialPort;

    return {
      getActivePort: () => activePort,
      setActivePort: (value) => {
        activePort = value;
      },
    };
  };

  return {
    initialize,
  };
};
