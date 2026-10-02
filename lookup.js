(() => {
  const form = document.getElementById("lookupForm");
  const input = document.getElementById("referenceNumber");
  const resultNode = document.getElementById("result");
  const reference = new URLSearchParams(window.location.search).get("ref");
  if (reference) input.value = reference;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    resultNode.textContent = "Checking the verification register…";
    try {
      const response = await fetch(`/lookup?ref=${encodeURIComponent(input.value.trim())}`);
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || "No verified record was found.");
      const card = document.createElement("section");
      card.className = "result-card";
      const heading = document.createElement("p");
      heading.className = "result-status";
      heading.textContent = result.status === "verified" ? "Authenticity confirmed · Active record" : "Record found · Status requires review";
      if (result.status !== "verified") heading.classList.add("invalid");
      const list = document.createElement("dl");
      list.className = "details";
      const details = [
        ["Document ID", result.referenceNumber],
        ["Employee", result.employeeName || "Not disclosed"],
        ["Employer", result.employerName],
        ["Purpose", result.purpose || "Employment verification"],
        ["Issued", new Date(result.timestamp).toLocaleString()],
        ["Authorized signatory", `${result.signatoryName}, ${result.signatoryTitle}`]
      ];
      details.forEach(([label, value]) => {
        const item = document.createElement("div");
        const term = document.createElement("dt");
        const description = document.createElement("dd");
        term.textContent = label;
        description.textContent = value;
        item.append(term, description);
        list.append(item);
      });
      card.append(heading, list);
      resultNode.replaceChildren(card);
    } catch (error) {
      const message = document.createElement("p");
      message.className = "error";
      message.textContent = error.message;
      resultNode.replaceChildren(message);
    } finally {
      button.disabled = false;
    }
  });
  if (reference) form.requestSubmit();
})();
