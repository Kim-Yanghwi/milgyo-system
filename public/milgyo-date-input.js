(() => {
  const BUFFER_TIMEOUT_MS = 3000;
  const weekdayNames = ['일','월','화','수','목','금','토'];

  const isDateInput = (target) => target instanceof HTMLInputElement && target.type === 'date';
  const isEditableDate = (target) => isDateInput(target) && !target.disabled && !target.readOnly && !target.hasAttribute('data-no-date8');

  const parseDateValue = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (year < 1900 || year > 2200 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return { year, month, day, date };
  };

  const draftText = (digits) => {
    const padded = `${digits}${'________'.slice(digits.length)}`;
    return `${padded.slice(0, 4)}-${padded.slice(4, 6)}-${padded.slice(6, 8)}`;
  };

  const ensureVisualParts = (input) => {
    if (!isDateInput(input) || input.hasAttribute('data-no-weekday')) return null;
    let wrapper = input.closest('.date-with-weekday,.managed-date-with-weekday');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.className = 'date-with-weekday';
      input.before(wrapper);
      wrapper.append(input);
    }

    let shell = input.closest('.date-input-shell,.managed-date-input-shell');
    if (!shell) {
      shell = document.createElement('div');
      shell.className = 'date-input-shell';
      input.before(shell);
      shell.append(input);
    }

    let display = shell.querySelector('.date-display-value,.managed-date-display');
    if (!display) {
      display = document.createElement('span');
      display.className = 'date-display-value';
      display.setAttribute('aria-hidden', 'true');
      shell.append(display);
    }

    let weekday = wrapper.querySelector('.date-weekday,.managed-date-weekday');
    if (!weekday) {
      weekday = document.createElement('span');
      weekday.className = 'date-weekday';
      weekday.setAttribute('aria-live', 'polite');
      wrapper.append(weekday);
    }
    return { wrapper, shell, display, weekday };
  };

  const syncVisual = (input) => {
    const parts = ensureVisualParts(input);
    if (!parts) return;
    const { shell, display, weekday } = parts;
    if (input.dataset.numericDateBuffer !== undefined) {
      shell.dataset.numericDateDrafting = '1';
      display.textContent = draftText(String(input.dataset.numericDateBuffer || ''));
      display.classList.remove('is-placeholder');
      display.hidden = false;
      weekday.hidden = true;
      return;
    }
    delete shell.dataset.numericDateDrafting;
    const parsed = parseDateValue(input.value);
    display.textContent = parsed ? input.value : '연도-월-일';
    display.classList.toggle('is-placeholder', !parsed);
    // DATE_NATIVE_FIRST_V51
    display.hidden = true;
    weekday.textContent = parsed ? `(${weekdayNames[parsed.date.getUTCDay()]})` : '';
    weekday.hidden = !parsed;
  };

  const clearBuffer = (input) => {
    delete input.dataset.numericDateBuffer;
    delete input.dataset.numericDateBufferAt;
    input.setCustomValidity('');
    syncVisual(input);
  };

  const setNativeEditing = (input, active) => {
    const shell = input.closest('.date-input-shell,.managed-date-input-shell');
    shell?.classList.toggle('is-native-editing', !!active);
  };

  const showDraft = (input, digits) => {
    input.dataset.numericDateBuffer = digits;
    input.dataset.numericDateBufferAt = String(Date.now());
    input.setCustomValidity('');
    syncVisual(input);
  };

  const applyDigits = (input, digits) => {
    if (!/^\d{8}$/.test(digits)) return false;
    const value = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    if (!parseDateValue(value)) {
      showDraft(input, digits);
      input.setCustomValidity('올바른 날짜 8자리를 입력해 주세요. 예: 20260819');
      input.reportValidity?.();
      return false;
    }
    input.value = value;
    input.dataset.nativeDateEdit = '1';
    setNativeEditing(input, true);
    delete input.dataset.numericDateBuffer;
    delete input.dataset.numericDateBufferAt;
    input.setCustomValidity('');
    syncVisual(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  const prepare = (input) => {
    if (!isDateInput(input)) return;
    input.lang = 'en-CA';
    input.inputMode = 'numeric';
    if (!input.title && !input.hasAttribute('data-no-date8')) {
      input.title = '숫자 8자리(예: 20260819)를 연속 입력하거나 달력에서 날짜를 선택할 수 있습니다.';
    }
    if (!input.hasAttribute('data-no-weekday')) ensureVisualParts(input);
    syncVisual(input);
    if (input.dataset.milgyoDateVisualBound) return;
    input.dataset.milgyoDateVisualBound = '1';
    input.addEventListener('input', () => syncVisual(input));
    input.addEventListener('change', () => syncVisual(input));
  };

  document.addEventListener('focus', (event) => {
    const input = event.target;
    if (!isEditableDate(input)) return;
    if (parseDateValue(input.value)) {
      input.dataset.nativeDateEdit = '1';
      setNativeEditing(input, true);
    } else {
      delete input.dataset.nativeDateEdit;
      setNativeEditing(input, false);
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    const input = event.target;
    if (!isEditableDate(input) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (input.dataset.nativeDateEdit === '1') return;

    if (/^\d$/.test(event.key)) {
      event.preventDefault();
      const lastAt = Number(input.dataset.numericDateBufferAt || 0);
      let digits = Date.now() - lastAt <= BUFFER_TIMEOUT_MS ? String(input.dataset.numericDateBuffer || '') : '';
      if (digits.length >= 8) digits = '';
      digits += event.key;
      showDraft(input, digits);
      if (digits.length === 8) applyDigits(input, digits);
      return;
    }

    if (event.key === 'Backspace' && input.dataset.numericDateBuffer !== undefined) {
      event.preventDefault();
      const digits = String(input.dataset.numericDateBuffer || '').slice(0, -1);
      if (digits) showDraft(input, digits);
      else clearBuffer(input);
      return;
    }

    if (event.key === 'Escape' && input.dataset.numericDateBuffer !== undefined) {
      event.preventDefault();
      clearBuffer(input);
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

  document.addEventListener('blur', (event) => {
    const input = event.target;
    if (!isEditableDate(input)) return;
    if (input.dataset.numericDateBuffer !== undefined) clearBuffer(input);
    delete input.dataset.nativeDateEdit;
    setNativeEditing(input, false);
  }, true);

  const prepareAll = (root = document) => {
    if (isDateInput(root)) prepare(root);
    root.querySelectorAll?.('input[type="date"]').forEach(prepare);
  };

  window.__MILGYO_SYNC_DATE_INPUTS__ = prepareAll;
  prepareAll();
  window.dispatchEvent(new CustomEvent('milgyo:date-inputs-ready'));
  window.addEventListener('milgyo:managed-dates-ready', () => prepareAll());
  document.addEventListener('reset', (event) => {
    const root = event.target instanceof Element ? event.target : document;
    setTimeout(() => prepareAll(root), 0);
  }, true);
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) prepareAll(node);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
