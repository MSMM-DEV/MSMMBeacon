// Page-entry feedback is independent of component mounting and data state.
export function playPageArrival(element, { reducedMotion = false, duration = 260 } = {}) {
  if (reducedMotion || !element?.animate) return () => {};
  const animation = element.animate(
    [{ opacity: .65, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
    { duration, easing: "cubic-bezier(.22, 1, .36, 1)" }
  );
  // Cancel on navigation or a changed motion preference; never wait for an
  // animation to finish before accepting another interaction.
  return () => animation.cancel();
}
