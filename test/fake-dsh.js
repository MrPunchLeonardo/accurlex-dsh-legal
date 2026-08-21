export function createFakeDshContext() {
  const registered = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {
          const index = registered.indexOf(definition);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
  };
  return { ctx, registered };
}

export function execution(signal = new AbortController().signal) {
  return { signal };
}
