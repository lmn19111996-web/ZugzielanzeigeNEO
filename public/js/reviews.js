// === REVIEWS PAGE ===
    async function renderReviewsPage() {
      const trainListEl = document.getElementById('train-list');
      if (!trainListEl) return;

      trainListEl.innerHTML = '';

      let reviews = [];
      try {
        const res = await fetch('/api/journal');
        const data = await res.json();
        reviews = data.reviews || [];
      } catch (e) {
        console.error('Failed to load reviews:', e);
      }

      const page = document.createElement('div');
      page.className = 'reviews-page';

      // Header
      const header = document.createElement('div');
      header.className = 'reviews-page-header';
      const titleEl = document.createElement('h2');
      titleEl.className = 'reviews-page-title';
      titleEl.textContent = 'Rezensionen';

      const newBtn = document.createElement('button');
      newBtn.className = 'reviews-new-btn';
      newBtn.textContent = '+ Neue Rezension';
      newBtn.addEventListener('click', function() {
        if (typeof window.openReviewWriteDrawer === 'function') window.openReviewWriteDrawer(null, function() { renderReviewsPage(); });
      });

      header.append(titleEl, newBtn);
      page.appendChild(header);

      // Stats row
      const statsRow = document.createElement('div');
      statsRow.className = 'reviews-stats-row';

      const total = reviews.length;
      const avg = total ? reviews.reduce(function(a, r) { return a + r.rating; }, 0) / total : 0;

      // Average card
      const avgCard = document.createElement('div');
      avgCard.className = 'reviews-avg-card';
      const avgNumEl = document.createElement('div');
      avgNumEl.className = 'reviews-avg-number';
      avgNumEl.textContent = total ? avg.toFixed(1) : '–';
      const avgStarsEl = document.createElement('div');
      avgStarsEl.className = 'reviews-avg-stars';
      for (let i = 1; i <= 5; i++) {
        const s = document.createElement('span');
        let cls = 'rv-star';
        if (i <= Math.floor(avg)) cls += ' filled';
        else if (i <= avg + 0.5 && i > avg) cls += ' half';
        s.className = cls;
        s.textContent = '★';
        avgStarsEl.appendChild(s);
      }
      const avgLabelEl = document.createElement('div');
      avgLabelEl.className = 'reviews-avg-label';
      avgLabelEl.textContent = total ? '(' + total + ')' : 'Noch keine Einträge';
      avgCard.append(avgNumEl, avgStarsEl, avgLabelEl);

      // Bar chart card
      const barsCard = document.createElement('div');
      barsCard.className = 'reviews-bars-card';
      const barsTitle = document.createElement('div');
      barsTitle.className = 'reviews-bars-title';
      barsTitle.textContent = 'Bewertungsverteilung';
      barsCard.appendChild(barsTitle);

      const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      reviews.forEach(function(r) { counts[r.rating] = (counts[r.rating] || 0) + 1; });
      const maxCount = total ? Math.max.apply(null, Object.values(counts)) : 1;
      for (let star = 5; star >= 1; star--) {
        const n = counts[star] || 0;
        const pct = total ? Math.round((n / maxCount) * 100) : 0;
        const row = document.createElement('div');
        row.className = 'rv-bar-row';
        row.innerHTML = '<div class="rv-bar-label"><span class="rv-star">★</span>' + star + '</div>'
          + '<div class="rv-bar-count">' + n + '</div>'
          + '<div class="rv-bar-track"><div class="rv-bar-fill" style="width:0%"></div></div>';
        barsCard.appendChild(row);
        (function(fillEl, p) {
          requestAnimationFrame(function() { fillEl.style.width = p + '%'; });
        })(row.querySelector('.rv-bar-fill'), pct);
      }

      statsRow.append(avgCard, barsCard);
      page.appendChild(statsRow);

      // ── Filter bar ─────────────────────────────────────────
      const filterBar = document.createElement('div');
      filterBar.className = 'reviews-filter-bar';

      function buildFilterBtn(label, rating) {
        const btn = document.createElement('button');
        btn.className = 'reviews-filter-btn' + (_reviewsFilterRating === rating ? ' active' : '');
        btn.textContent = label;
        btn.addEventListener('click', function() {
          _reviewsFilterRating = rating;
          renderReviewsPage();
        });
        return btn;
      }

      filterBar.appendChild(buildFilterBtn('Alle', 0));
      for (let s = 5; s >= 1; s--) {
        filterBar.appendChild(buildFilterBtn(s + ' ★', s));
      }
      page.appendChild(filterBar);

      // Section title
      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'reviews-section-title';
      const filtered = _reviewsFilterRating ? reviews.filter(function(r) { return r.rating === _reviewsFilterRating; }) : reviews;
      sectionTitle.textContent = _reviewsFilterRating
        ? filtered.length + ' Rezension' + (filtered.length !== 1 ? 'en' : '') + ' mit ' + _reviewsFilterRating + ' ★'
        : 'Alle Rezensionen';
      page.appendChild(sectionTitle);

      // Review list
      const list = document.createElement('div');
      list.className = 'reviews-list';
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'reviews-empty';
        empty.textContent = reviews.length === 0 ? 'Noch keine Rezensionen vorhanden.' : 'Keine Rezensionen mit ' + _reviewsFilterRating + ' ★.';
        list.appendChild(empty);
      } else {
        filtered.forEach(function(r) {
          list.appendChild(buildReviewCard(r, function() { renderReviewsPage(); }));
        });
      }
      page.appendChild(list);

      trainListEl.appendChild(page);
    }

    function buildReviewCard(r, onRefresh) {
      function esc(str) {
        return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                          .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      }
      function fmtDate(iso) {
        if (!iso) return '';
        return new Date(iso + 'T00:00:00').toLocaleDateString('de-DE', {
          weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
        });
      }
      function starsInner(rating, editable) {
        let h = '';
        for (let i = 1; i <= 5; i++) {
          h += '<span class="rv-star' + (i <= rating ? ' filled' : '') + '"' 
            + (editable ? ' data-val="' + i + '"' : '') + '>★</span>';
        }
        return h;
      }

      const card = document.createElement('div');
      card.className = 'rv-card';

      function renderView() {
        card.innerHTML = '<div class="rv-card-header">'
          + '<div class="rv-card-date">' + fmtDate(r.date) + '</div>'
          + '<div class="rv-dots-wrap">'
          + '<button class="rv-dots-btn" aria-label="Optionen">'
          + '<img class="rv-dots-icon" src="res/3dotsvertical.svg" alt=""></button>'
          + '<div class="rv-dropdown" style="display:none;">'
          + '<button class="rv-dropdown-item" data-action="edit">Bearbeiten</button>'
          + '<button class="rv-dropdown-item rv-dropdown-delete" data-action="delete">Löschen</button>'
          + '</div></div></div>'
          + '<div class="rv-card-stars">' + starsInner(r.rating, false) + '</div>'
          + '<div class="rv-card-text' + (!r.text ? ' empty' : '') + '">'
          + (r.text ? esc(r.text) : 'Kein Text.') + '</div>';

        const dotsBtn  = card.querySelector('.rv-dots-btn');
        const dropdown = card.querySelector('.rv-dropdown');

        dotsBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          const isOpen = dropdown.style.display !== 'none';
          dropdown.style.display = isOpen ? 'none' : 'block';
          if (!isOpen) {
            function closeDropdown(e) {
              if (!card.contains(e.target)) {
                dropdown.style.display = 'none';
                document.removeEventListener('click', closeDropdown);
              }
            }
            document.addEventListener('click', closeDropdown);
          }
        });

        card.querySelector('[data-action="delete"]').addEventListener('click', async function() {
          try {
            const res = await fetch('/api/journal/' + r.id, { method: 'DELETE' });
            if (!res.ok) throw new Error('Fehler');
            if (onRefresh) onRefresh();
          } catch (e) { alert(e.message); }
        });
        card.querySelector('[data-action="edit"]').addEventListener('click', function() {
          dropdown.style.display = 'none';
          if (typeof window.openReviewWriteDrawer === 'function') {
            window.openReviewWriteDrawer(r, function() { if (onRefresh) onRefresh(); });
          }
        });
      }

      renderView();
      return card;
    }
