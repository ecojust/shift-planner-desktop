/** Track navigation intent rather than relying on :focus-visible for text inputs:
 * browsers intentionally match it after a mouse click as well as keyboard use. */
export function installFocusBehavior(doc: Document = document): () => void {
  const root = doc.documentElement
  const previous = root.getAttribute('data-focus-mode')
  const setMode = (mode: 'pointer' | 'keyboard') => { root.dataset.focusMode = mode }
  const pointer = () => setMode('pointer')
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === 'Tab') setMode('keyboard')
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      const target = event.target
      // Typing or moving the caret after a click must not bring the ring back.
      const editingText = target instanceof Element && (target.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable]:not([contenteditable="false"])') || !!target.closest('[contenteditable="true"]'))
      if (!editingText) setMode('keyboard')
    }
  }
  setMode('pointer')
  doc.addEventListener('pointerdown', pointer, { capture: true, passive: true })
  doc.addEventListener('keydown', keyboard, true)
  return () => {
    doc.removeEventListener('pointerdown', pointer, true)
    doc.removeEventListener('keydown', keyboard, true)
    if (previous === null) root.removeAttribute('data-focus-mode')
    else root.setAttribute('data-focus-mode', previous)
  }
}
