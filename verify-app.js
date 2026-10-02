(() => {
  const form = document.getElementById("verifyForm");
  if (!form) return;

  const status = document.getElementById("formStatus");
  const generateButton = document.getElementById("generateButton");
  const previewCard = document.getElementById("previewCard");
  const canvas = document.getElementById("signatureCanvas");
  const context = canvas.getContext("2d");
  let currentReference = "";
  let drawing = false;
  let hasSignature = false;
  let signaturePreviewUrl = "";
  let logoPreviewUrl = "";

  const value = (name, fallback) => form.elements[name]?.value.trim() || fallback;
  const setText = (id, text) => { document.getElementById(id).textContent = text; };

  function updatePreview() {
    const employee = value("employeeName", "the employee");
    const lifecycle = value("lifecycle", "Current Employee");
    const former = lifecycle === "Former Employee";
    const compensationRedacted = document.getElementById("redactCompensation").checked;
    const startDate = value("startDate", "the start date");
    const endDate = value("endDate", "");
    const pay = compensationRedacted ? "[REDACTED]" : value("basePay", "the base pay rate");
    const ytd = compensationRedacted ? "[REDACTED]" : value("ytdGross", "the YTD earnings");
    const bonus = compensationRedacted ? "[REDACTED]" : value("bonus", "the bonus amount");
    const hours = value("averageHours", "the average hours");
    const department = value("department", "the department");
    const jobTitle = value("jobTitle", "the job title");
    const workStatus = value("workStatus", "work status");
    const purpose = value("purpose", "verification");
    const representative = value("representativeName", "the representative");
    const representativePhone = value("representativePhone", "the representative phone");
    const representativeEmail = value("representativeEmail", "the representative email");

    setText("previewEmployer", value("employerName", "EMPLOYER LEGAL NAME").toUpperCase());
    setText("previewAddress", [
      value("employerAddress", "Corporate address"),
      value("employerPhone", "Business phone"),
      value("employerEmail", "HR email")
    ].join(" · "));
    const paragraphs = window.LetterTemplate.createVerificationParagraphs({
      employeeName: employee,
      jobTitle,
      departmentName: department,
      startDate,
      workStatus,
      lifecycle,
      endDate: endDate || "the recorded separation date",
      rehireEligibility: value("rehireEligibility", "Conditional"),
      baseSalary: pay,
      payFrequency: value("payFrequency", "pay"),
      averageHours: hours,
      ytdEarnings: ytd,
      bonusAmount: bonus,
      overtimeEligibility: form.elements.overtimeEligible.value,
      verificationPurpose: purpose,
      representativeName: representative,
      representativePhone,
      representativeEmail,
      documentId: currentReference || "assigned at issuance"
    });
    setText("paragraphOne", paragraphs[0]);
    const ssnLast4 = value("ssnLast4", "");
    setText("ssnPreview", ssnLast4 ? `SSN: ${document.getElementById("redactSsn").checked ? "[REDACTED]" : `XXX-XX-${ssnLast4}`}` : "");
    setText("paragraphTwo", paragraphs[1]);
    setText("paragraphThree", paragraphs[2]);
    setText("previewMeta", currentReference ? `Document ID: ${currentReference} · ${new Date().toLocaleDateString()}` : "Document ID assigned at issuance");
    document.getElementById("sealPreview").hidden = !document.getElementById("corporateSeal").checked;
    setText("previewRepresentative", representative);
    setText("previewTitle", value("representativeTitle", "Representative title"));
    setText("disclaimerPreview", document.getElementById("liabilityDisclaimer").checked
      ? "Information provided reflects company records at the time of issuance and does not constitute a guarantee of future employment or compensation."
      : "");
    document.getElementById("notaryPreview").textContent = document.getElementById("notaryBlock").checked
      ? `NOTARY ACKNOWLEDGEMENT · ${value("notaryJurisdiction", "State / county jurisdiction")} · Commission expires ${value("commissionExpiration", "date not provided")} · Notary signature: __________________`
      : "";
    const signaturePreview = document.getElementById("signaturePreview");
    signaturePreview.replaceChildren();
    if (signaturePreviewUrl) {
      URL.revokeObjectURL(signaturePreviewUrl);
      signaturePreviewUrl = "";
    }
    const signatureMode = form.elements.signatureMode.value;
    if (signatureMode === "type") {
      const typed = document.createElement("span");
      typed.className = "script";
      typed.textContent = value("typedSignature", "");
      signaturePreview.append(typed);
    } else if (signatureMode === "draw" && hasSignature) {
      const image = document.createElement("img");
      image.src = canvas.toDataURL("image/png");
      image.alt = "Representative's drawn signature";
      signaturePreview.append(image);
    } else if (signatureMode === "upload" && document.getElementById("signatureFile").files[0]) {
      const image = document.createElement("img");
      signaturePreviewUrl = URL.createObjectURL(document.getElementById("signatureFile").files[0]);
      image.src = signaturePreviewUrl;
      image.alt = "Representative's uploaded signature";
      signaturePreview.append(image);
    }
    if (logoPreviewUrl) {
      URL.revokeObjectURL(logoPreviewUrl);
      logoPreviewUrl = "";
    }
    const logoFile = document.getElementById("employerLogo").files[0];
    const logoImage = document.getElementById("previewLogo");
    logoImage.hidden = !logoFile;
    if (logoFile) {
      logoPreviewUrl = URL.createObjectURL(logoFile);
      logoImage.src = logoPreviewUrl;
    } else {
      logoImage.removeAttribute("src");
    }
  }

  function resizeCanvas() {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width) return;
    const previous = hasSignature ? canvas.toDataURL("image/png") : "";
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(bounds.width * ratio);
    canvas.height = Math.round(bounds.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.lineWidth = 2;
    context.lineCap = "round";
    context.strokeStyle = "#17243a";
    if (previous) {
      const image = new Image();
      image.onload = () => {
        context.drawImage(image, 0, 0, bounds.width, bounds.height);
        updatePreview();
      };
      image.src = previous;
    }
  }
  function point(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }
  canvas.addEventListener("pointerdown", (event) => {
    drawing = true;
    canvas.setPointerCapture(event.pointerId);
    const p = point(event);
    context.beginPath();
    context.moveTo(p.x, p.y);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drawing) return;
    const p = point(event);
    context.lineTo(p.x, p.y);
    context.stroke();
    hasSignature = true;
    updatePreview();
  });
  canvas.addEventListener("pointerup", () => { drawing = false; });
  canvas.addEventListener("pointercancel", () => { drawing = false; });
  document.getElementById("clearSignature").addEventListener("click", () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    hasSignature = false;
    updatePreview();
  });
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  form.addEventListener("input", updatePreview);
  form.addEventListener("change", updatePreview);
  form.elements.lifecycle.addEventListener("change", () => {
    const former = form.elements.lifecycle.value === "Former Employee";
    document.getElementById("separationField").hidden = !former;
    form.elements.endDate.required = former;
  });
  form.elements.signatureMode.forEach((radio) => radio.addEventListener("change", () => {
    ["draw", "upload", "type"].forEach((mode) => {
      document.getElementById(`${mode}Panel`).hidden = radio.value !== mode || !radio.checked;
    });
    updatePreview();
  }));
  document.getElementById("notaryBlock").addEventListener("change", (event) => {
    document.getElementById("notaryFields").hidden = !event.target.checked;
  });

  fetch("/api/auth/session", { credentials: "same-origin" }).then(async (response) => {
    if (!response.ok) return;
    const session = await response.json();
    const { employer, officer } = session;
    form.elements.employerName.value = employer.legalName || "";
    form.elements.employerAddress.value = employer.businessAddress || "";
    form.elements.employerPhone.value = employer.businessPhone || "";
    form.elements.employerEmail.value = employer.businessEmail || "";
    form.elements.representativeName.value = officer.fullName || "";
    form.elements.representativeTitle.value = officer.title || "";
    form.elements.representativeEmail.value = officer.email || "";
    ["employerName", "employerAddress", "employerPhone", "employerEmail", "representativeName", "representativeTitle", "representativeEmail"]
      .forEach((name) => { form.elements[name].readOnly = true; });
    document.getElementById("authNotice").hidden = true;
    updatePreview();
  }).catch(() => {});

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, type: file.type || "application/octet-stream", data: reader.result });
      reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
      reader.readAsDataURL(file);
    });
  }

  async function download(format) {
    if (!currentReference) return;
    const response = await fetch(`/api/letters/${encodeURIComponent(currentReference)}/export?format=${format}`, { credentials: "same-origin" });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.message || "Unable to download this document.");
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `employment-verification-${currentReference}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  }
  document.getElementById("downloadPdf").addEventListener("click", () => download("pdf").catch((error) => { status.textContent = error.message; }));
  document.getElementById("downloadDocx").addEventListener("click", () => download("docx").catch((error) => { status.textContent = error.message; }));
  document.getElementById("emailLetter").addEventListener("click", async () => {
    const recipientEmail = form.elements.recipientEmail.value.trim();
    const sendTo = recipientEmail || form.elements.employerEmail.value.trim();
    if (!sendTo) { status.textContent = "Enter a recipient email or HR email before sending."; return; }
    try {
      const response = await fetch(`/api/letters/${encodeURIComponent(currentReference)}/email`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ recipientEmail: sendTo })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Unable to send this document.");
      status.textContent = result.message;
    } catch (error) { status.textContent = error.message; }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "Preparing encrypted document record…";
    generateButton.disabled = true;
    try {
      const attachments = await Promise.all(Array.from(document.getElementById("attachments").files, readFile));
      const logo = document.getElementById("employerLogo").files[0];
      const signatureFile = document.getElementById("signatureFile").files[0];
      const data = Object.fromEntries(new FormData(form).entries());
      data.overtimeEligible = form.elements.overtimeEligible.value;
      data.signatureMode = form.elements.signatureMode.value;
      data.signatureData = data.signatureMode === "draw" && hasSignature ? canvas.toDataURL("image/png") : "";
      if (data.signatureMode === "type") data.signatureData = form.elements.typedSignature.value.trim();
      if (data.signatureMode === "upload" && signatureFile) data.signatureData = (await readFile(signatureFile)).data;
      data.attachments = attachments;
      data.logoData = logo ? (await readFile(logo)).data : "";
      data.redactSsn = document.getElementById("redactSsn").checked;
      data.redactCompensation = document.getElementById("redactCompensation").checked;
      data.corporateSeal = document.getElementById("corporateSeal").checked;
      data.liabilityDisclaimer = document.getElementById("liabilityDisclaimer").checked;
      data.notaryBlock = document.getElementById("notaryBlock").checked;

      const response = await fetch("/api/letters", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify(data)
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401) {
          document.getElementById("authNotice").hidden = false;
          throw new Error("Sign in with a verified HR account to issue this letter.");
        }
        throw new Error(result.message || "Unable to generate the verification letter.");
      }
      currentReference = result.referenceNumber;
      form.elements.employerName.value = result.employerName;
      form.elements.employerAddress.value = result.employerAddress;
      form.elements.employerPhone.value = result.employerPhone;
      form.elements.employerEmail.value = result.employerEmail;
      setText("paragraphOne", result.paragraphs[0]);
      setText("paragraphTwo", result.paragraphs[1]);
      setText("paragraphThree", result.paragraphs[2]);
      setText("previewEmployer", result.employerName.toUpperCase());
      setText("previewMeta", `Document ID: ${result.referenceNumber} · ${new Date(result.timestamp).toLocaleString()}`);
      const qr = document.createElement("img");
      qr.src = result.qrCode;
      qr.alt = "Scannable document verification QR code";
      const qrLabel = document.createElement("span");
      qrLabel.textContent = `Verify at ${window.location.origin}/lookup · ${result.signerTag}`;
      document.getElementById("qrPreview").replaceChildren(qr, qrLabel);
      ["downloadPdf", "downloadDocx", "emailLetter"].forEach((id) => { document.getElementById(id).disabled = false; });
      status.textContent = `Letter issued and saved securely. Document ID: ${result.referenceNumber}`;
      updatePreview();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      generateButton.disabled = false;
    }
  });

  document.getElementById("openPreview").addEventListener("click", () => previewCard.classList.add("open"));
  document.getElementById("openPreviewTop").addEventListener("click", () => previewCard.classList.add("open"));
  document.getElementById("closePreview").addEventListener("click", () => previewCard.classList.remove("open"));
  updatePreview();
})();
