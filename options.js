const $ = (id) => document.getElementById(id);

async function load() {
  const data = await chrome.storage.local.get(["profile", "autoApplySettings", "mistralApiKey"]);
  const profile = data.profile || {};
  const settings = data.autoApplySettings || {};

  // Profile fields
  $("fullName").value = profile.fullName || "";
  $("email").value = profile.email || "";
  $("phone").value = profile.phone || "";
  $("location").value = profile.location || "";
  $("postalCode").value = profile.postalCode || "";
  $("title").value = profile.title || "";
  $("experience").value = profile.experience || "";
  $("stack").value = profile.stack || "";
  $("languages").value = profile.languages || "";
  $("availability").value = profile.availability || "";
  $("salaryExpectation").value = profile.salaryExpectation || "";
  $("cvText").value = profile.cvText || "";

  // Mistral API key
  $("mistralApiKey").value = data.mistralApiKey || "";

  // Settings
  $("maxJobsPerSession").value = settings.maxJobsPerSession || 25;
  $("delayJobMin").value = settings.delayBetweenJobs?.min || 6000;
  $("delayJobMax").value = settings.delayBetweenJobs?.max || 14000;
  $("delayStepMin").value = settings.delayBetweenSteps?.min || 700;
  $("delayStepMax").value = settings.delayBetweenSteps?.max || 1600;
  $("maxNoApplyPages").value = settings.maxConsecutiveNoApplyPages || 1;
}

async function save() {
  const profile = {
    fullName: $("fullName").value.trim(),
    firstName: $("fullName").value.trim().split(" ")[0],
    lastName: $("fullName").value.trim().split(" ").slice(1).join(" "),
    email: $("email").value.trim(),
    phone: $("phone").value.trim(),
    location: $("location").value.trim(),
    postalCode: $("postalCode").value.trim(),
    title: $("title").value.trim(),
    experience: $("experience").value.trim(),
    stack: $("stack").value.trim(),
    languages: $("languages").value.trim(),
    availability: $("availability").value.trim(),
    salaryExpectation: $("salaryExpectation").value.trim(),
    cvText: $("cvText").value.trim(),
  };

  const mistralApiKey = $("mistralApiKey").value.trim();
  const autoApplySettings = {
    maxJobsPerSession: parseInt($("maxJobsPerSession").value, 10) || 25,
    delayBetweenJobs: {
      min: parseInt($("delayJobMin").value, 10) || 6000,
      max: parseInt($("delayJobMax").value, 10) || 14000,
    },
    delayBetweenSteps: {
      min: parseInt($("delayStepMin").value, 10) || 700,
      max: parseInt($("delayStepMax").value, 10) || 1600,
    },
    autoSubmit: true,
    onlyEasyApply: true,
    maxConsecutiveNoApplyPages: parseInt($("maxNoApplyPages").value, 10) || 1,
  };

  await chrome.storage.local.set({ profile, autoApplySettings });
  if (mistralApiKey) {
    await chrome.storage.local.set({ mistralApiKey });
  }
  $("toast").textContent = "✅ Configuration sauvegardée";
  setTimeout(() => {
    $("toast").textContent = "";
  }, 2000);
}

document.getElementById("saveBtn").addEventListener("click", save);
load();
