/**
 * ELAborate - Single Report Viewer (Strict DOM Manipulation)
 */

let allReportsMeta = [];

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const reportId = urlParams.get('id');

  // Bind the copy link button
  document.getElementById('copyLinkBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(() => alert("Report link copied!"));
  });

  if (!reportId) {
    showEmptyState("No Report Selected", "Please enter a search term below or return to the archive to find a specific ledger.");
    return;
  }

  fetchReport(reportId);
});

// --- STATE MANAGEMENT ---
function switchState(stateToShow) {
  document.getElementById('loadingState').classList.add('hidden');
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('reportState').classList.add('hidden');

  document.getElementById(stateToShow).classList.remove('hidden');
}

// --- FETCH & POPULATE REPORT ---
async function fetchReport(id) {
  try {
    // 1. Fetch metadata index to find the exact subfolder path
    let filePath = `content/reports/${id}.json`;

    const indexRes = await fetch('content/reports/index.json');
    if (indexRes.ok) {
      const indexData = await indexRes.json();
      const meta = indexData.find(item => item.id === id);
      if (meta && meta.file) {
        filePath = `content/reports/${meta.file}`;
      }
    }

    // 2. Fetch the actual report JSON
    const response = await fetch(filePath);
    if (!response.ok) throw new Error('Report not found');

    const reportData = await response.json();
    populateReportUI(reportData);
    switchState('reportState');

  } catch (error) {
    console.error(error);
    showEmptyState("Report Not Found", "The experiment ledger you are looking for might have been moved or does not exist.");
  }
}

function populateReportUI(data) {
  document.title = `${data.code || 'Lab'} Report — ELAborate`;
  
  // Safely grab content
  const content = data.content || {};
  const apparatusList = content.apparatus || [];
  const procedureList = content.procedure || [];

  // Populate Header
  document.getElementById('reportCode').textContent = data.code || 'UNKNOWN';
  document.getElementById('reportTitle').textContent = data.title || 'Untitled Document';
  document.getElementById('reportDept').textContent = (data.department || 'N/A').toUpperCase();
  document.getElementById('reportLevel').textContent = `${data.level || 'N/A'}L`;
  
  if (data.verified) {
    document.getElementById('reportVerified').classList.remove('hidden');
  }

  // Populate Body Paragraphs
  document.getElementById('reportObjective').textContent = content.objective || 'No objective provided.';
  document.getElementById('reportTheory').textContent = content.theory || 'No theory provided.';
  document.getElementById('reportConclusion').textContent = content.conclusion || 'No conclusion provided.';

  // Populate Lists (Apparatus)
  const apparatusEl = document.getElementById('reportApparatus');
  apparatusEl.innerHTML = ''; // clear loading state safely
  if (apparatusList.length) {
    apparatusList.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;
      apparatusEl.appendChild(li);
    });
  } else {
    apparatusEl.innerHTML = '<li>Not specified</li>';
  }

  // Populate Lists (Procedure)
  const procedureEl = document.getElementById('reportProcedure');
  procedureEl.innerHTML = ''; 
  if (procedureList.length) {
    procedureList.forEach(step => {
      const li = document.createElement('li');
      li.textContent = step;
      procedureEl.appendChild(li);
    });
  } else {
    procedureEl.innerHTML = '<li>Not specified</li>';
  }

  initScrollSpy();
}

// --- POPULATE EMPTY STATE & SEARCH ---
async function showEmptyState(title, message) {
  document.getElementById('emptyTitle').textContent = title;
  document.getElementById('emptyMessage').textContent = message;
  switchState('emptyState');

  // Load search metadata in background
  if (!allReportsMeta.length) {
    try {
      const res = await fetch('content/reports/index.json');
      if (res.ok) allReportsMeta = await res.json();
    } catch (e) {
      console.error("Failed to load search metadata", e);
    }
  }

  const searchInput = document.getElementById('inlineSearch');
  const resultsContainer = document.getElementById('inlineSearchResults');

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    resultsContainer.innerHTML = ''; // Clear results safely
    
    if (!query) return;

    const filtered = allReportsMeta.filter(r => 
      r.title.toLowerCase().includes(query) || 
      r.code.toLowerCase().includes(query)
    ).slice(0, 5);

    if (filtered.length === 0) {
      const p = document.createElement('p');
      p.className = 'no-results';
      p.textContent = `No reports found matching "${query}"`;
      resultsContainer.appendChild(p);
      return;
    }

    filtered.forEach(r => {
      // Build minimal card via DOM elements to prevent XSS
      const a = document.createElement('a');
      a.href = `report.html?id=${r.id}`;
      a.className = 'minimal-card';
      
      a.innerHTML = `
        <div class="minimal-card-left">
          <span class="minimal-code">${r.code}</span>
          <span class="minimal-title">${r.title}</span>
        </div>
        <span class="material-symbols-outlined minimal-arrow">arrow_forward</span>
      `;
      resultsContainer.appendChild(a);
    });
  });
}

// --- SCROLL SPY LOGIC ---
function initScrollSpy() {
  const sections = document.querySelectorAll('.scroll-section');
  const navLinks = document.querySelectorAll('.toc-link');
  
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        navLinks.forEach(link => link.classList.remove('active'));
        const activeLink = document.querySelector(`.toc-link[href="#${entry.target.id}"]`);
        if (activeLink) activeLink.classList.add('active');
      }
    });
  }, { rootMargin: '-100px 0px -60% 0px' });
  
  sections.forEach(section => observer.observe(section));
}