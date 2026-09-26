let generatedLetter = "";
const premiumPaymentsEnabled = window.USEVS_LAUNCH_CONFIG?.premiumPaymentsEnabled === true;

document.querySelectorAll("[data-premium-control]").forEach((control) => {
  control.hidden = !premiumPaymentsEnabled;
});
document.querySelectorAll("[data-premium-unavailable]").forEach((notice) => {
  notice.hidden = premiumPaymentsEnabled;
});

const issuerLogoutButton = document.getElementById("issuerLogoutButton");
if (issuerLogoutButton) {
  fetch("/api/auth/session", { credentials: "same-origin" })
    .then((response) => {
      if (!response.ok) throw new Error("Sign-in required");
      return response.json();
    })
    .then((session) => {
      document.getElementById("issuerEmployerName").textContent = session.employer.legalName;
      document.getElementById("issuerOfficerName").textContent = `${session.officer.fullName} · ${session.officer.title}`;
    })
    .catch(() => window.location.replace("/issuer"));

  issuerLogoutButton.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    window.location.replace("/issuer");
  });
}

const addOfficerForm = document.getElementById("addOfficerForm");
if (addOfficerForm) {
  addOfficerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const status = document.getElementById("addOfficerStatus");
    button.disabled = true;
    status.textContent = "Adding HR signatory...";
    try {
      const response = await fetch("/api/employers/officers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          fullName: form.elements.fullName.value,
          title: form.elements.title.value,
          email: form.elements.email.value,
          password: form.elements.password.value
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Unable to add signatory.");
      form.reset();
      status.textContent = result.message;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

function renderLetter(text, output) {
  const fragment = document.createDocumentFragment();

  LetterPdf.getLetterLines(text).forEach((line) => {
    if (line.type === "blank") return;

    const element = document.createElement(line.type === "title" || line.type === "section" ? "h3" : "p");
    element.className = line.type === "title"
      ? "letter-title"
      : line.type === "section"
        ? "letter-section-title"
        : line.type === "metadata"
          ? "letter-meta"
          : "letter-line";

    if (line.type === "body") {
      const separator = line.text.indexOf(":");
      if (separator >= 0) {
        const label = document.createElement("strong");
        label.textContent = line.text.slice(0, separator + 1);
        element.append(label, document.createTextNode(line.text.slice(separator + 1)));
      } else {
        element.textContent = line.text;
      }
    } else {
      element.textContent = line.text;
    }

    fragment.append(element);
  });

  output.replaceChildren(fragment);
}

const downloadButton = document.getElementById("downloadPdfButton");
if (downloadButton) {
  downloadButton.addEventListener("click", () => {
    if (!generatedLetter) return;

    const downloadUrl = URL.createObjectURL(LetterPdf.createPdfBlob(generatedLetter));
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = "employment_verification_letter.pdf";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  });
}

const verifyForm = document.getElementById("verifyForm");
if (verifyForm) {
  verifyForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const button = e.currentTarget.querySelector('button[type="submit"]');
    const output = document.getElementById("output");
    const downloadButton = document.getElementById("downloadPdfButton");
    generatedLetter = "";
    downloadButton.disabled = true;

    const data = {
      employeeName: document.getElementById("employeeName").value,
      jobTitle: document.getElementById("jobTitle").value,
      startDate: document.getElementById("startDate").value,
      endDate: document.getElementById("endDate").value
    };

    button.disabled = true;
    output.innerText = "Generating letter...";

    try {
      const response = await fetch("/api/letters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(data)
      });

      const result = await response.json();
      if (response.ok && result.success) {
        generatedLetter = result.letter;
        renderLetter(generatedLetter, output);
        downloadButton.disabled = false;
      } else {
        output.innerText = "Error: " + (result.message || "Unable to generate the letter.");
      }
    } catch (error) {
      output.innerText = "Error: Unable to contact the server. Please try again.";
    } finally {
      button.disabled = false;
    }
  });
}

const lookupForm = document.getElementById("lookupForm");
if (lookupForm) {
  const referenceFromUrl = new URLSearchParams(window.location.search).get("ref");
  lookupForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const button = e.currentTarget.querySelector('button[type="submit"]');
    const output = document.getElementById("output");

    const referenceNumber = document.getElementById("referenceNumber").value.trim();
    if (!referenceNumber) {
      output.innerText = "Enter a reference number to verify the letter.";
      return;
    }

    button.disabled = true;
    output.innerText = "Checking reference...";

    try {
      const response = await fetch(`/lookup?ref=${encodeURIComponent(referenceNumber)}`);
      const result = await response.json();
      if (response.ok && result.success) {
        output.textContent = [
          `Employer authorization: Verified`,
          `Record status: ${result.status === "verified" ? "Active" : "Expired"}`,
          `Reference number: ${result.referenceNumber}`,
          `Verified employer: ${result.employerName} (${result.employerEmail})`,
          `Authorized signatory: ${result.signatoryName}, ${result.signatoryTitle} (${result.signatoryEmail})`,
          `Generated: ${result.timestamp}`
        ].join("\n");
      } else {
        output.innerText = "Error: " + (result.message || "Unable to verify this letter.");
      }
    } catch (error) {
      output.innerText = "Error: Unable to contact the server. Please try again.";
    } finally {
      button.disabled = false;
    }
  });

  if (referenceFromUrl) {
    document.getElementById("referenceNumber").value = referenceFromUrl;
    lookupForm.requestSubmit();
  }
}

const adminDashboard = document.getElementById("adminDashboard");
if (adminDashboard) {
  const statsStatus = document.getElementById("statsStatus");
  const resultsStatus = document.getElementById("resultsStatus");
  const resultsBody = document.getElementById("searchResultsBody");
  const recentBody = document.getElementById("recentLettersBody");
  const letterDialog = document.getElementById("letterDialog");
  const emailDialog = document.getElementById("emailDialog");
  const emailForm = document.getElementById("emailForm");
  const emailStatus = document.getElementById("emailStatus");
  let emailReferenceNumber = "";

  function setStatus(element, message, isError = false) {
    element.textContent = message;
    element.classList.toggle("status-error", isError);
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "The request could not be completed.");
    return result;
  }

  function addTextCell(row, value, className = "") {
    const cell = document.createElement("td");
    cell.textContent = value || "—";
    if (className) cell.className = className;
    row.append(cell);
    return cell;
  }

  function createActionButton(label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "table-action";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function downloadLetter(entry) {
    if (typeof entry.letter !== "string" || !entry.letter) return;

    const downloadUrl = URL.createObjectURL(LetterPdf.createPdfBlob(entry.letter));
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = "employment_verification_letter.pdf";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  }

  function showLetter(entry) {
    if (typeof entry.letter !== "string") {
      setStatus(resultsStatus, "The selected entry does not contain a letter.", true);
      return;
    }

    document.getElementById("letterDialogHeading").textContent = `Employment Letter · ${entry.referenceNumber || ""}`;
    renderLetter(entry.letter, document.getElementById("letterDialogOutput"));
    document.getElementById("letterDialogDownload").onclick = () => downloadLetter(entry);
    letterDialog.showModal();
  }

  function openEmailDialog(entry) {
    emailReferenceNumber = entry.referenceNumber;
    emailForm.reset();
    setStatus(emailStatus, "");
    emailDialog.showModal();
    emailForm.elements.email.focus();
  }

  function renderRows(entries, body, emptyMessage, includeActions) {
    body.replaceChildren();
    if (!entries.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = includeActions ? 5 : 4;
      cell.className = "empty-cell";
      cell.textContent = emptyMessage;
      row.append(cell);
      body.append(row);
      return;
    }

    entries.forEach((entry) => {
      const row = document.createElement("tr");
      addTextCell(row, entry.referenceNumber, "reference-cell");
      addTextCell(row, entry.employeeName);
      addTextCell(row, entry.employerName);
      addTextCell(row, entry.timestamp);

      if (includeActions) {
        const actionCell = document.createElement("td");
        const actions = document.createElement("div");
        actions.className = "actions-cell";
        actions.append(
          createActionButton("View Letter", () => showLetter(entry)),
          createActionButton("Download PDF", () => downloadLetter(entry))
        );
        if (premiumPaymentsEnabled) {
          actions.append(createActionButton("Send Email", () => openEmailDialog(entry)));
        }
        actionCell.append(actions);
        row.append(actionCell);
      }

      body.append(row);
    });
  }

  async function loadStats() {
    try {
      const stats = await requestJson("/admin/stats");
      document.getElementById("totalLetters").textContent = stats.totalLetters;
      document.getElementById("todayCount").textContent = stats.todayCount;
      document.getElementById("last7DaysCount").textContent = stats.last7DaysCount;
      setStatus(statsStatus, "Updated just now");
    } catch (error) {
      ["totalLetters", "todayCount", "last7DaysCount"].forEach((id) => {
        document.getElementById(id).textContent = "—";
      });
      setStatus(statsStatus, error.message || "Unable to load statistics.", true);
    }
  }

  async function loadRecentLetters() {
    try {
      const entries = await requestJson("/admin/recent");
      renderRows(entries, recentBody, "No letters generated yet.", false);
    } catch (error) {
      renderRows([], recentBody, error.message || "Unable to load recent letters.", false);
    }
  }

  async function searchLetters(query) {
    setStatus(resultsStatus, "Loading results...");
    try {
      const entries = await requestJson(`/admin/search${query ? `?${query}` : ""}`);
      renderRows(entries, resultsBody, "No letters match these filters.", true);
      setStatus(resultsStatus, `${entries.length} result${entries.length === 1 ? "" : "s"}`);
    } catch (error) {
      renderRows([], resultsBody, error.message || "Unable to search letters.", true);
      setStatus(resultsStatus, "Search failed", true);
    }
  }

  document.getElementById("adminSearchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const parameters = new URLSearchParams();
    ["employeeName", "employerName", "referenceNumber"].forEach((field) => {
      const value = String(formData.get(field) || "").trim();
      if (value) parameters.set(field, value);
    });
    searchLetters(parameters.toString());
  });

  emailForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = emailForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    setStatus(emailStatus, "Sending email...");

    try {
      const result = await requestJson("/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: emailForm.elements.email.value.trim(),
          referenceNumber: emailReferenceNumber
        })
      });
      setStatus(emailStatus, result.message || "Email sent successfully.");
    } catch (error) {
      setStatus(emailStatus, error.message || "Unable to send email.", true);
    } finally {
      submitButton.disabled = false;
    }
  });

  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });

  loadStats();
  loadRecentLetters();
  searchLetters("");
}
