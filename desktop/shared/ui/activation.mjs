export function activationEvents(action, enabled = true) {
  const activate = event => {
    if (!enabled || event?.currentTarget?.getAttribute?.('aria-disabled') === 'true' ||
        (event?.button !== undefined && event.button !== 0)) return false;
    event?.stopPropagation?.();
    return action();
  };
  return {
    onClick: activate,
    onKeydown: event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!event.repeat && !event.isComposing) return activate(event);
      }
    },
  };
}
