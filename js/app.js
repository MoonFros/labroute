let repositoryData = { gallery: [], reports: [] };

document.addEventListener('DOMContentLoaded', () => {
  // Kick off the data loading as soon as the page is ready
  loadRepositoryData();
});

// 1. Fetch JSON Content Concurrently
async function loadRepositoryData() {
  try {
    const [galleryRes, reportsRes] = await Promise.all([
      fetch('content/gallery.json'),
      fetch('content/reports/index.json')
    ]);

    if (!galleryRes.ok || !reportsRes.ok) throw new Error('Failed to load JSON data');
    
    // `.reverse()` ensures items added to the bottom of your JSON show up first
    repositoryData.gallery = (await galleryRes.json()).reverse();
    repositoryData.reports = (await reportsRes.json()).reverse();

    // Render only the latest 8 images and latest 6 reports on initial load
    renderGallery(repositoryData.gallery.slice(0, 8));
    renderReports(repositoryData.reports.slice(0, 6));
    
    // Initialize interactions AFTER data is on the page
    initFilterEvents();
    initGalleryDrag();
  } catch (error) {
    console.error('Error fetching repository data:', error);
  }
}

// 2. Render Gallery HTML (Masonry Layout)
function renderGallery(items) {
  const container = document.getElementById('galleryMasonryGrid');
  if (!container || !items) return;

  // We assign a pseudo-random shape to each image to force the scattered layout
  const shapes = ['tall', 'standard', 'square', 'tall']; 

  container.innerHTML = items
    .map((item, index) => {
      const shapeClass = shapes[index % shapes.length];
      return `
      <figure class="gallery-card ${shapeClass}">
        <img src="${item.image}" alt="${item.title}" class="gallery-image" loading="lazy" />
      </figure>`;
    })
    .join('');
}

// 3. Render Reports HTML
function renderReports(reports) {
  const container = document.getElementById('reportsGrid');
  if (!container) return;

  if (!reports.length) {
    container.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: var(--text-muted);">No reports found matching your criteria.</p>`;
    return;
  }

  container.innerHTML = reports
    .map(
      (report) => `
      <article class="ledger-card">
        <div class="ledger-card-header">
          <span class="course-pill">${report.code}</span>
          ${
            report.verified
              ? `<span class="status-indicator"><span class="dot"></span> Verified</span>`
              : ''
          }
        </div>
        <h3 class="ledger-title">${report.title}</h3>
        <p class="ledger-meta">Dept of ${report.department.toUpperCase()} • ${report.level}L</p>
        <div class="ledger-footer">
          <a href="report.html?id=${report.id}" class="btn-link">
            <span>View Full Report</span>
            <span class="material-symbols-outlined">arrow_outward</span>
          </a>
        </div>
      </article>`
    )
    .join('');
}

// 4. Client-side Search & Filtering (Includes your Interactive Topic Chips)
function initFilterEvents() {
  const searchInput = document.getElementById('reportSearchInput');
  const deptFilter = document.getElementById('deptFilter');
  const levelFilter = document.getElementById('levelFilter');
  const filterChips = document.querySelectorAll('.filter-chip');

  let activeTag = 'all';

  function applyFilters() {
    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const dept = deptFilter ? deptFilter.value : 'all';
    const level = levelFilter ? levelFilter.value : 'all';
    
    // Check if the user is actually searching/filtering
    const isSearching = query !== '' || dept !== 'all' || level !== 'all' || activeTag !== 'all';

    let filtered = repositoryData.reports.filter((item) => {
      const matchesSearch =
        item.title.toLowerCase().includes(query) ||
        item.code.toLowerCase().includes(query);
      const matchesDept = dept === 'all' || item.department === dept;
      const matchesLevel = level === 'all' || item.level === level;
      const matchesTag = activeTag === 'all' || (item.tags && item.tags.includes(activeTag));

      return matchesSearch && matchesDept && matchesLevel && matchesTag;
    });

    // If no search is active, shrink the list back to the latest 6
    if (!isSearching) {
      filtered = filtered.slice(0, 6);
    }

    renderReports(filtered);
  }

  // Bind dropdowns and text search
  if (searchInput) searchInput.addEventListener('input', applyFilters);
  if (deptFilter) deptFilter.addEventListener('change', applyFilters);
  if (levelFilter) levelFilter.addEventListener('change', applyFilters);

  // Bind your interactive chips logic here
  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      // Toggle active class
      filterChips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      
      // Filter by tag logic
      const tagText = chip.textContent.replace('#', '').trim();
      activeTag = chip.textContent.trim().toLowerCase() === 'all' ? 'all' : tagText;
      applyFilters();
    });
  });

  // NEW: Handle Incoming Cross-Page Search Queries from the URL
  const urlParams = new URLSearchParams(window.location.search);
  const incomingSearchQuery = urlParams.get('search');

  if (incomingSearchQuery && searchInput) {
    // 1. Auto-fill the search box with the word from the URL
    searchInput.value = incomingSearchQuery;
    
    // 2. Trigger the filter function immediately
    applyFilters(); 
    
    // 3. Smooth scroll down to the reports section
    setTimeout(() => {
      const reportsSection = document.getElementById('Reports');
      if (reportsSection) {
        reportsSection.scrollIntoView({ behavior: 'smooth' });
      }
    }, 100); // 100ms delay ensures the DOM has updated before scrolling
  }
}

// 5. Mouse Drag-to-Scroll for the Portrait Gallery (Your custom interaction)
function initGalleryDrag() {
  const slider = document.getElementById('galleryScrollContainer');
  if (!slider) return;

  let isDown = false;
  let startX;
  let scrollLeft;

  slider.addEventListener('mousedown', (e) => {
    isDown = true;
    startX = e.pageX - slider.offsetLeft;
    scrollLeft = slider.scrollLeft;
  });

  slider.addEventListener('mouseleave', () => {
    isDown = false;
  });

  slider.addEventListener('mouseup', () => {
    isDown = false;
  });

  slider.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - slider.offsetLeft;
    const walk = (x - startX) * 1.5; // Scroll sensitivity
    slider.scrollLeft = scrollLeft - walk;
  });
}