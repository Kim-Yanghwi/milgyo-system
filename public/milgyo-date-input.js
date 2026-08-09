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

  const shellFor = (input) => {
    let shell = input.closest('.date-input-shell,.managed-date-input-shell');
    if (shell) return shell;
    shell = document.createElement('div');
    shell.className = 'date-input-shell';
    input.before(shell);
    shell.append(input);
    return shell;
  };

  const displayFor = (input, create = false) => {
    const shell = create ? shellFor(input) : input.closest('.date-input-shell,.managed-date-input-shell');
    if (!shell) return null;
    let display = shell.querySelector('.date-display-value,.managed-date-display');
    if (!display && create) {
      display = document.createElement('span');
      display.className = 'date-display-value';
      display.setAttribute('aria-hidden', 'true');
      shell.append(display);
    }
    return display;
  };

  const showDraft = (input, digits) => {
    input.dataset.numericDateBuffer = digits;
    input.dataset.numericDateBufferAt = String(Date.now());
    const shell = shellFor(input);
    shell.dataset.numericDateDrafting = '1';
    const display = displayFor(input, true);
    if (!display) return;
    display.textContent = draftText(digits);
    display.hidden = false;
  };

  const clearBuffer = (input) => {
    delete input.dataset.numericDateBuffer;
    delete input.dataset.numericDateBufferAt;
    const shell = input.closest('.date-input-shell,.managed-date-input-shell');
    if (shell) delete shell.dataset.numericDateDrafting;
    const display = displayFor(input);
    if (display) display.hidden = true;
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
    input.dataset.nativeDateEdit = '1';
    clearBuffer(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  const prepare = (input) => {
    if (!(input instanceof HTMLInputElement) || input.type !== 'date') return;
    input.inputMode = 'numeric';
    if (!input.title) input.title = '날짜의 연·월·일을 직접 수정하거나, 빈 칸에서는 숫자 8자리(예: 20260809)를 연속 입력할 수 있습니다.';
  };

  document.addEventListener('focusin', (event) => {
    const input = event.target;
    if (!isEditableDate(input)) return;
    // 포커스를 받을 때 이미 값이 있으면 해당 포커스 세션 전체를 브라우저 기본
    // 연·월·일 구간 편집에 맡깁니다. 월/일 한 구간을 지운 뒤 다시 입력해도
    // 8자리 일괄 입력 모드로 갑자기 전환되지 않습니다.
    if (input.value) input.dataset.nativeDateEdit = '1';
    else delete input.dataset.nativeDateEdit;
  }, true);

  document.addEventListener('keydown', (event) => {
    const input = event.target;
    if (!isEditableDate(input) || event.ctrlKey || event.metaKey || event.altKey) return;

    // 값이 이미 있는 날짜는 브라우저의 연·월·일 구간 편집을 그대로 사용합니다.
    // 따라서 특정 연도·월·일만 고칠 때 전체 날짜가 선택되거나 지워지지 않습니다.
    if (/^\d$/.test(event.key)) {
      if (input.dataset.nativeDateEdit === '1') return;
      if (input.value && input.dataset.numericDateBuffer === undefined) {
        input.dataset.nativeDateEdit = '1';
        return;
      }
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
      }
      return;
    }

    if (event.key === 'Escape' && input.dataset.numericDateBuffer !== undefined) {
      clearBuffer(input);
      input.setCustomValidity('');
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
    if (input.dataset.numericDateBuffer !== undefined) {
      clearBuffer(input);
      input.setCustomValidity('');
    }
    delete input.dataset.nativeDateEdit;
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
