(() => {
  const form = document.getElementById('i9Form');
  if (!form) return;

  const status = document.getElementById('formStatus');
  const rulesStatus = document.getElementById('rulesStatus');
  const recordRows = document.getElementById('recordRows');
  const recordsStatus = document.getElementById('recordsStatus');
  const saveButton = document.getElementById('saveI9');

  function displayDateToIso(value) {
    if (!value) return '';
    const match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(value);
    if (!match) throw new Error('Enter dates in DD/MM/YY format.');
    const [, day, month, shortYear] = match;
    const shortYearNumber = Number(shortYear);
    const year = shortYearNumber >= 50 ? 1900 + shortYearNumber : 2000 + shortYearNumber;
    const parsed = new Date(Date.UTC(year, Number(month) - 1, Number(day)));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== Number(month) - 1 || parsed.getUTCDate() !== Number(day)) {
      throw new Error('Enter a valid calendar date.');
    }
    return `${year}-${month}-${day}`;
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'The request could not be completed.');
    return result;
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      if (file.size > 4000000) {
        reject(new Error('Each supporting document must be smaller than 4 MB.'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, type: file.type, data: reader.result });
      reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
      reader.readAsDataURL(file);
    });
  }

  async function updateRules() {
    const workState = form.elements.workState.value;
    const employeeCount = Number(form.elements.employeeCount.value);
    if (!workState || !Number.isSafeInteger(employeeCount) || employeeCount < 0) {
      rulesStatus.className = 'rule-status wide';
      rulesStatus.textContent = 'Select the work state and employee count to evaluate the rules.';
      return;
    }
    rulesStatus.textContent = 'Checking applicable rules…';
    try {
      const result = await requestJson('/api/i9/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workState,
          employeeCount,
          offerAccepted: form.elements.offerAccepted.checked,
          eVerifyEnrolled: form.elements.eVerifyEnrolled.checked,
          eVerifyRequested: form.elements.eVerifyRequested.checked,
          stateLawReviewConfirmed: form.elements.stateLawReviewConfirmed.checked
        })
      });
      rulesStatus.className = `rule-status wide ${result.allowed ? result.manualReviewRequired ? '' : 'good' : 'error'}`;
      rulesStatus.textContent = [
        ...result.requirements,
        ...result.errors,
        result.manualReviewRequired ? 'Verify additional state and local requirements with counsel or the official E-Verify state-law resource before proceeding.' : ''
      ].filter(Boolean).join(' ') || 'No additional rule is identified by this limited rules engine.';
    } catch (error) {
      rulesStatus.className = 'rule-status wide error';
      rulesStatus.textContent = error.message;
    }
  }

  function addCell(row, value) {
    const cell = document.createElement('td');
    cell.textContent = value || '—';
    row.append(cell);
    return cell;
  }

  function isoDateToDisplay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!match) return value || '';
    const [, year, month, day] = match;
    return `${day}/${month}/${year.slice(-2)}`;
  }

  async function loadRecords() {
    recordRows.replaceChildren();
    try {
      const result = await requestJson('/api/i9/records');
      result.records.forEach((record) => {
        const row = document.createElement('tr');
        addCell(row, record.employeeName);
        addCell(row, record.workState);
        addCell(row, record.authorizationExpiration ? isoDateToDisplay(record.authorizationExpiration) : 'Not recorded');
        const section3 = addCell(row, record.hasSection3Draft ? 'Draft available' : record.authorizationExpiration ? 'Scheduled' : 'Not applicable');
        if (record.hasSection3Draft) {
          const button = document.createElement('button');
          button.className = 'button secondary';
          button.type = 'button';
          button.textContent = 'Open draft';
          button.addEventListener('click', () => window.open(`/api/i9/records/${encodeURIComponent(record.recordId)}/section3`, '_blank', 'noopener'));
          section3.replaceChildren(button);
        }
        const worksheet = addCell(row, '');
        const link = document.createElement('a');
        link.className = 'button secondary';
        link.href = `/api/i9/records/${encodeURIComponent(record.recordId)}/export`;
        link.textContent = 'PDF';
        worksheet.append(link);
        recordRows.append(row);
      });
      recordsStatus.textContent = `${result.records.length} I-9 record${result.records.length === 1 ? '' : 's'}.`;
    } catch (error) {
      recordsStatus.textContent = error.message;
    }
  }

  ['workState', 'employeeCount', 'offerAccepted', 'eVerifyEnrolled', 'eVerifyRequested', 'stateLawReviewConfirmed'].forEach((name) => {
    form.elements[name].addEventListener('input', updateRules);
    form.elements[name].addEventListener('change', updateRules);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    status.textContent = 'Encrypting and saving verification record…';
    try {
      if (!document.getElementById('postersDisplayed').checked) {
        throw new Error('Confirm that the employee saw both federal notices before collecting data.');
      }
      const data = Object.fromEntries(new FormData(form).entries());
      displayDateToIso(data.hireDate);
      displayDateToIso(data.authorizationExpiration);
      ['offerAccepted', 'eVerifyEnrolled', 'eVerifyRequested', 'stateLawReviewConfirmed', 'remoteProcedure', 'dhsProcedureEligible', 'liveVideoConfirmed', 'employeeSelectedDocuments']
        .forEach((name) => { data[name] = form.elements[name].checked; });
      data.postersDisplayed = true;
      data.employeeCount = Number(data.employeeCount);
      data.authorizationDocuments = await Promise.all(Array.from(document.getElementById('authorizationDocuments').files, readFile));
      if (data.authorizationDocuments.reduce((total, file) => total + file.data.length, 0) > 5500000) {
        throw new Error('Keep combined authorization documents below the 4 MB total file-size limit.');
      }
      const result = await requestJson('/api/i9/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      form.reset();
      status.textContent = `Encrypted I-9 evidence record saved. Record ID: ${result.recordId}. ${result.outputNotice}`;
      await loadRecords();
      await updateRules();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      saveButton.disabled = false;
    }
  });

  requestJson('/api/auth/session').then(loadRecords).catch(() => window.location.replace('/auth'));
})();