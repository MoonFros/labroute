/**
 * MyEla - Developer Products & Ecosystem Loader
 */

document.addEventListener('DOMContentLoaded', () => {
  loadProducts();
});

async function loadProducts() {
  const container = document.getElementById('productsGrid');
  if (!container) return;

  try {
    const response = await fetch('content/products.json');
    if (!response.ok) throw new Error('Could not load products dataset.');

    const products = await response.json();
    renderProducts(products, container);

  } catch (error) {
    console.error(error);
    container.innerHTML = `
      <div class="loading-state">
        <p>Unable to load developer products at this moment. Check back shortly.</p>
      </div>
    `;
  }
}

function renderProducts(products, container) {
  if (!products.length) {
    container.innerHTML = '<p class="loading-state">No products registered yet.</p>';
    return;
  }

  container.innerHTML = products.map(item => `
    <article class="product-card">
      <div>
        <div class="product-top-row">
          <div class="product-icon-box">
            <span class="material-symbols-outlined">${item.icon || 'deployed_code'}</span>
          </div>
          <span class="product-status-pill">${item.status || 'Active'}</span>
        </div>

        <div class="product-body">
          <h2 class="product-name">${item.name}</h2>
          <p class="product-tagline">${item.tagline}</p>
          <p class="product-desc">${item.description}</p>
          
          <div class="product-tags-row">
            ${(item.tags || []).map(tag => `<span class="product-tag-chip">${tag}</span>`).join('')}
          </div>

          <div class="product-dev-credit">
            <span class="material-symbols-outlined" style="font-size: 16px;">code</span>
            <span>Developed by <strong>${item.developer}</strong></span>
          </div>
        </div>
      </div>

      <div class="product-footer">
        <a href="${item.link}" target="_blank" rel="noopener noreferrer" class="btn btn-gold btn-product-launch">
          <span>Open Application</span>
          <span class="material-symbols-outlined">launch</span>
        </a>
      </div>
    </article>
  `).join('');
}