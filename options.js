const $ = (id) => document.getElementById(id);

async function load() {
  const data = await chrome.storage.local.get(["profile", "autoApplySettings"]);
  const profile = data.profile || {};
  const settings = data.autoApplySettings || {};

  $("fullName").value = profile.fullName || "";
  $("email").value = profile.email || "";
  $("phone").value = profile.phone || "";
  $("location").value = profile.location || "";

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
    email: $("email").value.trim(),
    phone: $("phone").value.trim(),
    location: $("location").value.trim(),
  };

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
  $("toast").textContent = "Sauvegarde OK";
  setTimeout(() => {
    $("toast").textContent = "";
  }, 1800);
}

document.getElementById("saveBtn").addEventListener("click", save);
load();
