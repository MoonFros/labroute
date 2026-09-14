/**
 * Labroute - Single Report Viewer Logic (Synchronized Schema Engine)
 */

let allReportsMeta = [];

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const reportId = urlParams.get('id');

  // Copy URL Link
  document.getElementById('copyLinkBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(() => alert("Report link copied to clipboard!"));
  });

  if (!reportId) {
    showEmptyState("No Report Selected", "Please select a specific lab report from the repository or search below.");
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

// --- FETCH & RESOLVE REPORT ---
async function fetchReport(id) {
  try {
    let filePath = `content/reports/${id}.json`;

    // Check index.json to find subfolder file path (e.g. chemical/che-311.json)
    const indexRes = await fetch('content/reports/index.json');
    if (indexRes.ok) {
      const indexData = await indexRes.json();
      const meta = indexData.find(item => item.id === id);
      if (meta && meta.file) {
        filePath = `content/reports/${meta.file}`;
      }
    }

    const response = await fetch(filePath);
    if (!response.ok) throw new Error('Report not found');

    const reportData = await response.json();
    populateReportUI(reportData);
    switchState('reportState');

    // Report text is inserted after MathJax's first page scan, so explicitly
    // typeset the newly loaded JSON. Raw TeX remains visible if MathJax is
    // unavailable rather than making the report unusable.
    await window.LabrouteMath?.typeset(document.getElementById('reportState'));

  } catch (error) {
    console.error(error);
    showEmptyState("Report Not Found", "The experiment ledger you are looking for might have been moved or does not exist.");
  }
}

// --- POPULATE THE REPORT UI ---
function populateReportUI(data) {
  document.title = `${data.code || 'Lab'} Report — Labroute`;
  const content = data.content || {};

  // 1. Header Metadata
  document.getElementById('reportCode').textContent = data.code || 'UNKNOWN';
  document.getElementById('reportTitle').textContent = data.title || 'Untitled Document';
  document.getElementById('reportDept').textContent = (data.department || 'N/A').toUpperCase();
  document.getElementById('reportLevel').textContent = `${data.level || 'N/A'}L`;
  document.getElementById('reportSession').textContent = data.session || '2023/2024';
  
  if (data.verified) {
    document.getElementById('reportVerified').classList.remove('hidden');
  }

  // 2. Aim & Objectives
  document.getElementById('reportAim').textContent = content.aim || 'No formal aim statement provided.';
  
  const objectivesEl = document.getElementById('reportObjectives');
  objectivesEl.innerHTML = '';
  const objectives = Array.isArray(content.objectives) ? content.objectives : (content.objective ? [content.objective] : []);
  if (objectives.length) {
    objectives.forEach(obj => {
      const li = document.createElement('li');
      li.textContent = obj;
      objectivesEl.appendChild(li);
    });
  } else {
    objectivesEl.innerHTML = '<li>General laboratory investigation.</li>';
  }

  // 3. Apparatus (Pills)
  const apparatusEl = document.getElementById('reportApparatus');
  apparatusEl.innerHTML = '';
  const apparatusList = Array.isArray(content.apparatus) ? content.apparatus : [];
  if (apparatusList.length) {
    apparatusList.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;
      apparatusEl.appendChild(li);
    });
  } else {
    apparatusEl.innerHTML = '<li>Standard Laboratory Equipment</li>';
  }

  // 4. Theory & Diagrams
  const theoryText = typeof content.theory === 'object' ? (content.theory.text || '') : (content.theory || '');
  document.getElementById('reportTheory').textContent = theoryText || 'No theoretical description provided.';

  const diagramsContainer = document.getElementById('reportDiagrams');
  diagramsContainer.innerHTML = '';
  const diagrams = (content.theory && Array.isArray(content.theory.diagrams)) ? content.theory.diagrams : [];
  diagrams.forEach(diag => {
    if (diag.src) {
      const fig = document.createElement('figure');
      fig.className = 'report-figure';

      const image = document.createElement('img');
      image.src = diag.src;
      image.alt = diag.caption || 'Setup Diagram';
      image.loading = 'lazy';
      fig.appendChild(image);

      if (diag.caption) {
        const caption = document.createElement('figcaption');
        caption.textContent = diag.caption;
        fig.appendChild(caption);
      }
      diagramsContainer.appendChild(fig);
    }
  });

  // 5. Methodology & Precautions
  const procedureEl = document.getElementById('reportProcedure');
  procedureEl.innerHTML = '';
  const procedureList = Array.isArray(content.procedure) ? content.procedure : [];
  if (procedureList.length) {
    procedureList.forEach(step => {
      const li = document.createElement('li');
      li.textContent = step;
      procedureEl.appendChild(li);
    });
  } else {
    procedureEl.innerHTML = '<li>Refer to laboratory experimental manual.</li>';
  }

  const precautionsEl = document.getElementById('reportPrecautions');
  precautionsEl.innerHTML = '';
  const precautionsList = Array.isArray(content.precautions) ? content.precautions : [];
  if (precautionsList.length) {
    document.getElementById('precautionsWrapper').classList.remove('hidden');
    precautionsList.forEach(prec => {
      const li = document.createElement('li');
      li.textContent = prec;
      precautionsEl.appendChild(li);
    });
  } else {
    document.getElementById('precautionsWrapper').classList.add('hidden');
  }

  // 6. Empirical Data (Tables)
  const tablesContainer = document.getElementById('reportTables');
  tablesContainer.innerHTML = '';
  const tables = Array.isArray(content.tables) ? content.tables : [];
  tables.forEach(tableObj => {
    const wrapper = document.createElement('div');
    wrapper.className = 'table-render-card';

    if (tableObj.title) {
      const title = document.createElement('h4');
      title.className = 'table-card-title';
      title.textContent = tableObj.title;
      wrapper.appendChild(title);
    }

    const scrollWrapper = document.createElement('div');
    scrollWrapper.className = 'table-responsive-scroll';
    const tableEl = document.createElement('table');
    tableEl.className = 'rendered-data-table';

    // Create text nodes instead of interpolating JSON into HTML. This keeps
    // TeX source intact until MathJax reads it and prevents report data from
    // being interpreted as markup.
    if (Array.isArray(tableObj.headers) && tableObj.headers.length) {
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      tableObj.headers.forEach(header => {
        const th = document.createElement('th');
        th.textContent = String(header ?? '');
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      tableEl.appendChild(thead);
    }

    if (Array.isArray(tableObj.rows) && tableObj.rows.length) {
      const tbody = document.createElement('tbody');
      tableObj.rows.forEach(row => {
        const tr = document.createElement('tr');
        (Array.isArray(row) ? row : []).forEach(cell => {
          const td = document.createElement('td');
          td.textContent = String(cell ?? '');
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      tableEl.appendChild(tbody);
    }

    scrollWrapper.appendChild(tableEl);
    wrapper.appendChild(scrollWrapper);
    tablesContainer.appendChild(wrapper);
  });

  // Graphs
  const graphsContainer = document.getElementById('reportGraphs');
  graphsContainer.innerHTML = '';
  const graphs = Array.isArray(content.graphs) ? content.graphs : [];
  graphs.forEach(g => {
    if (g.src) {
      const fig = document.createElement('figure');
      fig.className = 'report-figure';

      const image = document.createElement('img');
      image.src = g.src;
      image.alt = g.title || 'Experimental Graph';
      image.loading = 'lazy';
      fig.appendChild(image);

      if (g.caption || g.title) {
        const caption = document.createElement('figcaption');
        caption.textContent = g.caption || g.title;
        fig.appendChild(caption);
      }
      graphsContainer.appendChild(fig);
    }
  });

  // 7. Discussion & Conclusion
  document.getElementById('reportDiscussion').textContent = content.discussion || 'No discussion submitted.';
  document.getElementById('reportConclusion').textContent = content.conclusion || 'No conclusion submitted.';

  // 8. Lab Manual Q&A
  const qaContainer = document.getElementById('reportQaList');
  qaContainer.innerHTML = '';
  const questions = Array.isArray(content.questions) ? content.questions : [];
  if (questions.length) {
    document.getElementById('sec-qa').classList.remove('hidden');
    document.getElementById('tocLinkQa')?.classList.remove('hidden');
    questions.forEach((qa, idx) => {
      const card = document.createElement('div');
      card.className = 'qa-display-card';

      const question = document.createElement('div');
      question.className = 'qa-q';
      const questionLabel = document.createElement('strong');
      questionLabel.textContent = `Q${idx + 1}:`;
      question.append(questionLabel, document.createTextNode(` ${qa.question || ''}`));

      const answer = document.createElement('div');
      answer.className = 'qa-a';
      const answerLabel = document.createElement('strong');
      answerLabel.textContent = 'Ans:';
      answer.append(answerLabel, document.createTextNode(` ${qa.answer || ''}`));

      card.append(question, answer);
      qaContainer.appendChild(card);
    });
  } else {
    document.getElementById('sec-qa').classList.add('hidden');
    document.getElementById('tocLinkQa')?.classList.add('hidden');
  }

  // 9. Key Learnings
  const learningsEl = document.getElementById('reportLearnings');
  learningsEl.innerHTML = '';
  const learnings = Array.isArray(content.learnings) ? content.learnings : [];
  if (learnings.length) {
    document.getElementById('sec-learnings').classList.remove('hidden');
    document.getElementById('tocLinkLearnings')?.classList.remove('hidden');
    learnings.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;
      learningsEl.appendChild(li);
    });
  } else {
    document.getElementById('sec-learnings').classList.add('hidden');
    document.getElementById('tocLinkLearnings')?.classList.add('hidden');
  }

  initScrollSpy();
}

// --- POPULATE EMPTY STATE & INLINE SEARCH ---
async function showEmptyState(title, message) {
  document.getElementById('emptyTitle').textContent = title;
  document.getElementById('emptyMessage').textContent = message;
  switchState('emptyState');

  if (!allReportsMeta.length) {
    try {
      const res = await fetch('content/reports/index.json');
      if (res.ok) allReportsMeta = await res.json();
    } catch (e) {
      console.error("Failed to load metadata", e);
    }
  }

  const searchInput = document.getElementById('inlineSearch');
  const resultsContainer = document.getElementById('inlineSearchResults');

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    resultsContainer.innerHTML = '';
    
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

// --- SCROLLSPY ---
function initScrollSpy() {
  const sections = document.querySelectorAll('.scroll-section:not(.hidden)');
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