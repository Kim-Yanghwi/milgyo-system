(() => {
  const BUFFER_TIMEOUT_MS = 2500;

  const isEditableDate = (target) => target instanceof HTMLInputElement
    && target.type === 'date' && !target.disabled && !target.readOnly;

  const isValidDate = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  };

  const draftText = (digits) => {
    const padded = `${digits}${'________'.slice(digits.length)}`;
    return `${padded.slice(0, 4)}-${padded.slice(4, 6)}-${padded.slice(6, 8)}`;
  };

  const displayFor = (input) => input.closest('.date-input-shell,.managed-date-input-shell')
    ?.querySelector('.date-display-value,.managed-date-display');

  const showDraft = (input, digits) => {
    input.dataset.numericDateBuffer = digits;
    input.dataset.numericDateBufferAt = String(Date.now());
    const display = displayFor(input);
    if (!display) return;
    display.textContent = digits ? draftText(digits) : (input.value || '연도-월-일');
    display.hidden = false;
    display.classList.toggle('is-placeholder', !digits && !input.value);
  };

  const clearBuffer = (input) => {
    delete input.dataset.numericDateBuffer;
    delete input.dataset.numericDateBufferAt;
  };

  const applyDigits = (input, digits) => {
    if (!/^\d{8}$/.test(digits)) return false;
    const value = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    if (!isValidDate(value)) {
      input.setCustomValidity('올바른 날짜 8자리를 입력해 주세요. 예: 20260809');
      showDraft(input, digits);
      return false;
    }
    input.setCustomValidity('');
    input.value = value;
    clearBuffer(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  const prepare = (input) => {
    if (!(input instanceof HTMLInputElement) || input.type !== 'date') return;
    input.inputMode = 'numeric';
    if (!input.title) input.title = '달력을 선택하거나 날짜 숫자 8자리(예: 20260809)를 입력하세요.';
  };

  document.addEventListener('keydown', (event) => {
    const input = event.target;
    if (!isEditableDate(input) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^\d$/.test(event.key)) {
      event.preventDefault();
      const lastAt = Number(input.dataset.numericDateBufferAt || 0);
      let digits = Date.now() - lastAt <= BUFFER_TIMEOUT_MS
        ? String(input.dataset.numericDateBuffer || '') : '';
      if (digits.length >= 8) digits = '';
      digits += event.key;
      input.setCustomValidity('');
      showDraft(input, digits);
      if (digits.length === 8) applyDigits(input, digits);
      return;
    }
    if (event.key === 'Backspace' && input.dataset.numericDateBuffer !== undefined) {
      event.preventDefault();
      const digits = String(input.dataset.numericDateBuffer || '').slice(0, -1);
      if (digits) showDraft(input, digits);
      else {
        clearBuffer(input);
        input.setCustomValidity('');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (event.key === 'Escape') {
      clearBuffer(input);
      input.setCustomValidity('');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, true);

  document.addEventListener('paste', (event) => {
    const input = event.target;
    if (!isEditableDate(input)) return;
    const digits = String(event.clipboardData?.getData('text') || '').replace(/\D/g, '');
    if (digits.length !== 8) return;
    event.preventDefault();
    applyDigits(input, digits);
  }, true);

  const prepareAll = (root = document) => {
    if (root instanceof HTMLInputElement && root.type === 'date') prepare(root);
    root.querySelectorAll?.('input[type="date"]').forEach(prepare);
  };

  prepareAll();
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) prepareAll(node);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
