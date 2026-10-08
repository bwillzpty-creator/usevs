(() => {
  const form = document.getElementById("filters");
  const tbody = document.getElementById("records");
  const status = document.getElementById("status");
  const dialog = document.getElementById("letterDialog");
  let records = [];

  function addCell(row, text, className) {
    const cell = document.createElement("td");
    cell.textContent = text || "—";
    if (className) cell.className = className;
    row.append(cell);
    return cell;
  }
  async function download(reference, format) {
    const response = await fetch(`/api/letters/${encodeURIComponent(reference)}/export?format=${format}`, { credentials: "same-origin" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || "Unable to download this letter.");
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `employment-verification-${reference}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  }
  async function resend(reference) {
    const recipientEmail = window.prompt("Email this letter to:", "");
    if (!recipientEmail) return;
    const response = await fetch(`/api/letters/${encodeURIComponent(reference)}/email`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientEmail })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Unable to send this letter.");
    status.textContent = result.message;
  }
  function render() {
    tbody.replaceChildren();
    if (!records.length) {
      const row = document.createElement("tr");
      const cell = addCell(row, "No matching verification records.", "empty");
      cell.colSpan = 6;
      tbody.append(row);
      return;
    }
    records.forEach((record) => {
      const row = document.createElement("tr");
      addCell(row, record.referenceNumber, "docid");
      addCell(row, record.employeeName);
      addCell(row, new Date(record.timestamp).toLocaleDateString());
      addCell(row, record.purpose);
      const badge = addCell(row, "Verified");
      badge.innerHTML = "";
      const pill = document.createElement("span");
      pill.className = "status-pill";
      pill.textContent = "Verified";
      badge.append(pill);
      const actions = addCell(row, "");
      actions.className = "actions";
      const view = document.createElement("button");
      view.type = "button";
      view.textContent = "View";
      view.addEventListener("click", () => {
        document.getElementById("letterContent").textContent = record.letter;
        dialog.showModal();
      });
      const pdf = document.createElement("button");
      pdf.type = "button";
      pdf.textContent = "PDF";
      pdf.addEventListener("click", () => download(record.referenceNumber, "pdf").catch((error) => { status.textContent = error.message; }));
      const word = document.createElement("button");
      word.type = "button";
      word.textContent = "Word";
      word.addEventListener("click", () => download(record.referenceNumber, "docx").catch((error) => { status.textContent = error.message; }));
      const email = document.createElement("button");
      email.type = "button";
      email.textContent = "Resend";
      email.addEventListener("click", () => resend(record.referenceNumber).catch((error) => { status.textContent = error.message; }));
      actions.append(view, pdf, word, email);
      tbody.append(row);
    });
  }
  async function search(event) {
    if (event) event.preventDefault();
    status.textContent = "Loading records…";
    const params = new URLSearchParams(new FormData(form));
    const displayDate = form.elements.date.value;
    if (displayDate) {
      const match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(displayDate);
      if (!match) {
        status.textContent = "Enter dates in DD/MM/YY format.";
        return;
      }
      const [, dayText, monthText, yearText] = match;
      const shortYear = Number(yearText);
      const year = shortYear >= 50 ? 1900 + shortYear : 2000 + shortYear;
      const date = new Date(Date.UTC(year, Number(monthText) - 1, Number(dayText)));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== Number(monthText) - 1 || date.getUTCDate() !== Number(dayText)) {
        status.textContent = "Enter a valid calendar date.";
        return;
      }
      params.set("date", `${year}-${monthText}-${dayText}`);
    }
    try {
      const response = await fetch(`/api/letters?${params}`, { credentials: "same-origin" });
      const result = await response.json();
      if (response.status === 401) document.getElementById("authNotice").hidden = false;
      if (!response.ok) throw new Error(result.message || "Unable to load records.");
      records = result.records;
      render();
      status.textContent = `${records.length} record${records.length === 1 ? "" : "s"} found.`;
    } catch (error) {
      status.textContent = error.message;
      records = [];
      render();
    }
  }
  form.addEventListener("submit", search);
  document.getElementById("closeDialog").addEventListener("click", () => dialog.close());
  search();
})();
