let repositoryData = { gallery: [], reports: [] };

document.addEventListener('DOMContentLoaded', () => {
  // Pagination controls exist before the first render; wire them once.
  initGalleryPagination();

  // Kick off the data loading as soon as the page is ready
  loadRepositoryData();
});

// 1. Fetch gallery and report content concurrently.
// The gallery first asks the upload service for the live, ordered list. On a
// static host (or before the service is running) it falls back to the JSON file.
async function loadRepositoryData() {
  const [galleryResult, reportsResult] = await Promise.allSettled([
    loadGalleryData(),
    loadReportsData()
  ]);

  if (galleryResult.status === 'fulfilled') {
    repositoryData.gallery = galleryResult.value;
  } else {
    console.error('Error fetching gallery data:', galleryResult.reason);
  }

  renderGallery(repositoryData.gallery);

  if (reportsResult.status === 'fulfilled') {
    repositoryData.reports = reportsResult.value;

    // Render the latest 6 reports on initial load
    renderReports(repositoryData.reports.slice(0, 6));

    // Initialize interactions AFTER data is on the page
    initFilterEvents();
  } else {
    console.error('Error fetching repository data:', reportsResult.reason);
  }

  initGalleryDrag();
}

async function loadGalleryData() {
  try {
    const response = await fetch('/api/gallery', {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.gallery)) return orderGallery(data.gallery);
    }
  } catch (error) {
    // The upload service is optional on a static deployment; use the file.
  }

  const fallback = await fetch(`content/gallery.json?v=${Date.now()}`, {
    cache: 'no-store'
  });

  if (!fallback.ok) throw new Error(`Gallery request failed with ${fallback.status}`);

  const data = await fallback.json();
  return orderGallery(Array.isArray(data) ? data : data.gallery || []);
}

// Community photos come first, newest first; the archive follows in file order.
// The API already returns this order — repeating it here keeps a static
// deployment (where /api/gallery does not exist) consistent with the server,
// no matter where a hand-published record sits in content/gallery.json.
function orderGallery(items) {
  const momentIsImage = (value) => {
    const image = String(value || '');
    return image.startsWith('assets/gallery/moments/') || /^https:\/\/.+\.blob\.vercel-storage\.com\//.test(image);
  };
  const isMoment = (item) => Boolean(item) && (item.uploaded === true || momentIsImage(item.image));
  const time = (item) => {
    const parsed = Date.parse(item.uploadedAt || item.approvedAt || '');
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const moments = items.filter(isMoment).sort((a, b) => time(b) - time(a));
  return moments.length ? [...moments, ...items.filter((item) => !isMoment(item))] : items;
}

async function loadReportsData() {
  const response = await fetch('content/reports/index.json');

  if (!response.ok) throw new Error(`Reports request failed with ${response.status}`);

  // `.reverse()` ensures items added to the bottom of the JSON show up first
  return (await response.json()).reverse();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

function safeImageSource(value) {
  const source = String(value ?? '');
  if (/^assets\/[A-Za-z0-9/._-]+$/.test(source)) return source;
  if (/^https:\/\//.test(source)) return source;
  return '';
}

// 2. Render Gallery HTML (Masonry Layout, nine photos per page)
// Nine keeps the desktop grid to a tidy 3x3 block and the mobile carousel to a
// handful of swipes, no matter how many photos the archive collects.
const GALLERY_PAGE_SIZE = 9;
const galleryView = { items: [], page: 0 };

function renderGallery(items) {
  const container = document.getElementById('galleryMasonryGrid');
  if (!container) return;

  galleryView.items = Array.isArray(items)
    ? items.filter((item) => item && safeImageSource(item.image))
    : [];
  galleryView.page = 0;

  if (!galleryView.items.length) {
    container.innerHTML = `
      <p class="gallery-empty">
        The gallery is being prepared. <a href="upload.html">Share the first moment</a>.
      </p>`;
    renderGalleryPagination();
    return;
  }

  renderGalleryPage();
}

function galleryPageCount() {
  return Math.max(1, Math.ceil(galleryView.items.length / GALLERY_PAGE_SIZE));
}

// Render only the current page of photos (at most GALLERY_PAGE_SIZE cards).
function renderGalleryPage() {
  const container = document.getElementById('galleryMasonryGrid');
  if (!container) return;

  const total = galleryView.items.length;
  const pages = galleryPageCount();
  const page = Math.min(Math.max(galleryView.page, 0), pages - 1);
  galleryView.page = page;

  const start = page * GALLERY_PAGE_SIZE;
  const visibleItems = galleryView.items.slice(start, start + GALLERY_PAGE_SIZE);

  // We assign a pseudo-random shape to each image to force the scattered layout
  const shapes = ['tall', 'standard', 'square', 'tall'];

  container.innerHTML = visibleItems
    .map((item, index) => {
      const position = start + index;
      const shapeClass = shapes[index % shapes.length];
      const caption = item.caption || item.title || 'A moment from the LabRoute archive';
      const image = safeImageSource(item.image);
      const contributor = String(item.contributor || '').trim();

      return `
      <figure class="gallery-card ${shapeClass}">
        ${position === 0 && item.uploaded ? '<span class="gallery-new-badge">New</span>' : ''}
        <img src="${escapeHtml(image)}" alt="${escapeHtml(caption)}" class="gallery-image" loading="lazy" />
        <figcaption class="gallery-caption">
          <h4>${escapeHtml(caption)}</h4>
          ${contributor ? `<p>${escapeHtml(contributor)}</p>` : ''}
        </figcaption>
      </figure>`;
    })
    .join('');

  renderGalleryPagination();
}

// Build the "showing x–y of n" line and the page controls.
function renderGalleryPagination() {
  const nav = document.getElementById('galleryPagination');
  const status = document.getElementById('galleryPageStatus');

  const total = galleryView.items.length;
  const pages = galleryPageCount();
  const page = Math.min(galleryView.page, pages - 1);
  const first = total ? page * GALLERY_PAGE_SIZE + 1 : 0;
  const last = Math.min(total, (page + 1) * GALLERY_PAGE_SIZE);

  if (status) {
    status.textContent = total
      ? `Showing ${first}–${last} of ${total} photo${total === 1 ? '' : 's'}`
      : '';
  }

  if (!nav) return;

  if (pages <= 1) {
    nav.hidden = true;
    nav.innerHTML = '';
    return;
  }

  const numbers = galleryPageNumbers(page, pages)
    .map((entry) => {
      if (entry === 'gap') return '<span class="gallery-page-gap" aria-hidden="true">…</span>';

      const isCurrent = entry === page;
      return `
        <button type="button"
                class="gallery-page-btn${isCurrent ? ' is-current' : ''}"
                data-gallery-page="${entry}"
                ${isCurrent ? 'aria-current="page"' : ''}
                aria-label="Page ${entry + 1} of ${pages}">${entry + 1}</button>`;
    })
    .join('');

  nav.innerHTML = `
    <button type="button" class="gallery-page-btn gallery-page-arrow" data-gallery-page="prev"
            aria-label="Previous photos" ${page === 0 ? 'disabled' : ''}>
      <span class="material-symbols-outlined" aria-hidden="true">chevron_left</span>
    </button>
    <div class="gallery-page-numbers">${numbers}</div>
    <button type="button" class="gallery-page-btn gallery-page-arrow" data-gallery-page="next"
            aria-label="Next photos" ${page >= pages - 1 ? 'disabled' : ''}>
      <span class="material-symbols-outlined" aria-hidden="true">chevron_right</span>
    </button>`;
  nav.hidden = false;
}

// 1 2 3 … 8 9 style page list, windowed around the current page.
function galleryPageNumbers(current, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index);

  const wanted = new Set([0, pages - 1, current - 1, current, current + 1]);
  const numbers = [...wanted].filter((page) => page >= 0 && page < pages).sort((a, b) => a - b);

  return numbers.reduce((list, page, index) => {
    if (index && page - numbers[index - 1] > 1) list.push('gap');
    list.push(page);
    return list;
  }, []);
}

function goToGalleryPage(page, options = {}) {
  const pages = galleryPageCount();
  const target = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
  const changed = target !== galleryView.page;

  galleryView.page = target;
  renderGalleryPage();

  const shouldScroll = options.scroll !== false;
  if (!changed || !shouldScroll) return;

  const grid = document.getElementById('galleryMasonryGrid');
  if (grid && typeof grid.scrollIntoView === 'function') {
    grid.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function initGalleryPagination() {
  const nav = document.getElementById('galleryPagination');
  if (!nav || nav.dataset.paginationReady === 'true') return;
  nav.dataset.paginationReady = 'true';

  nav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-gallery-page]');
    if (!button || button.disabled) return;

    const value = button.dataset.galleryPage;
    if (value === 'prev') goToGalleryPage(galleryView.page - 1);
    else if (value === 'next') goToGalleryPage(galleryView.page + 1);
    else goToGalleryPage(Number(value));
  });
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