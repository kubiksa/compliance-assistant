(function () {
  'use strict';

  const data = window.COMPLIANCE_DATA;
  if (!data) {
    document.getElementById('app').innerHTML =
      '<div class="empty-state">No data loaded.</div>';
    return;
  }

  const STATUS_LABELS = {
    verified: 'Verified',
    deviations_noted: 'Deviations noted',
    verification_pending: 'Verification pending'
  };

  const LAYER_ORDER = ['requirement', 'design', 'specification', 'verification'];
  const LAYER_LABELS = {
    requirement: 'Layer 1: Requirement',
    design: 'Layer 2: Design',
    specification: 'Layer 3: Specification',
    verification: 'Layer 4: Implementation and verification'
  };

  // Build lookup maps for fast rendering
  const regulationsById = Object.fromEntries(data.regulations.map(r => [r.id, r]));
  const documentsById = Object.fromEntries(data.documents.map(d => [d.id, d]));
  const rolesById = Object.fromEntries(data.roles.map(r => [r.id, r]));
  const mappingsByObligation = Object.fromEntries(
    data.mappings.map(m => [m.obligation_id, m])
  );

  // Enrich obligations with derived fields for convenient access
  const obligations = data.obligations.map(o => {
    const mapping = mappingsByObligation[o.id];
    return Object.assign({}, o, {
      status: mapping ? mapping.status : 'verification_pending',
      mapping: mapping || null,
      regulation: regulationsById[o.regulation_id] || null,
      role: o.accountable_role ? rolesById[o.accountable_role] : null
    });
  });

  // App state
  const state = {
    filterRegulation: 'all',
    filterStatus: 'all',
    selectedObligationId: null
  };

  // Minimal DOM builder helper
  function el(tag, attrs) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined) continue;
        if (k === 'class') node.className = v;
        else if (k === 'onclick') node.addEventListener('click', v);
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const child = arguments[i];
      if (child === null || child === undefined) continue;
      if (typeof child === 'string') {
        node.appendChild(document.createTextNode(child));
      } else {
        node.appendChild(child);
      }
    }
    return node;
  }

  function renderHeader() {
    const built = new Date(data.build_metadata.built_at);
    return el(
      'div',
      { class: 'header' },
      el('h1', { text: 'Compliance Catalog' }),
      el('div', {
        class: 'subtitle',
        text: 'Coverage view with drill-down traceability across the four-layer compliance model'
      }),
      el('div', {
        class: 'metadata',
        text:
          'Built ' +
          built.toLocaleString() +
          ' | ' +
          data.regulations.length +
          ' regulations, ' +
          data.obligations.length +
          ' obligations, ' +
          data.documents.length +
          ' documents'
      })
    );
  }

  function renderFilters() {
    const container = el('div', { class: 'filters' });

    // Regulation filter
    const regFilter = el(
      'div',
      { class: 'filter-group' },
      el('span', { class: 'filter-label', text: 'Regulation' }),
      el('button', {
        class: 'filter-btn' + (state.filterRegulation === 'all' ? ' active' : ''),
        onclick: function () {
          state.filterRegulation = 'all';
          render();
        },
        text: 'All'
      })
    );
    data.regulations.forEach(r => {
      regFilter.appendChild(
        el('button', {
          class: 'filter-btn' + (state.filterRegulation === r.id ? ' active' : ''),
          onclick: function () {
            state.filterRegulation = r.id;
            render();
          },
          text: r.name
        })
      );
    });
    container.appendChild(regFilter);

    // Status filter
    const statusFilter = el(
      'div',
      { class: 'filter-group' },
      el('span', { class: 'filter-label', text: 'Status' }),
      el('button', {
        class: 'filter-btn' + (state.filterStatus === 'all' ? ' active' : ''),
        onclick: function () {
          state.filterStatus = 'all';
          render();
        },
        text: 'All'
      })
    );
    ['verified', 'deviations_noted', 'verification_pending'].forEach(s => {
      statusFilter.appendChild(
        el('button', {
          class: 'filter-btn' + (state.filterStatus === s ? ' active' : ''),
          onclick: function () {
            state.filterStatus = s;
            render();
          },
          text: STATUS_LABELS[s]
        })
      );
    });
    container.appendChild(statusFilter);

    return container;
  }

  function renderOverview() {
    const filtered = obligations.filter(o => {
      if (state.filterRegulation !== 'all' && o.regulation_id !== state.filterRegulation) return false;
      if (state.filterStatus !== 'all' && o.status !== state.filterStatus) return false;
      return true;
    });

    if (filtered.length === 0) {
      return el('div', {
        class: 'empty-state',
        text: 'No obligations match the current filters.'
      });
    }

    const grid = el('div', { class: 'overview-grid' });
    filtered.forEach(o => {
      grid.appendChild(
        el(
          'div',
          {
            class: 'obligation-tile status-' + o.status,
            onclick: function () {
              state.selectedObligationId = o.id;
              render();
            }
          },
          el('div', {
            class: 'tile-regulation',
            text: o.regulation ? o.regulation.name : ''
          }),
          el('div', { class: 'tile-control-id', text: o.control_id || o.id }),
          el('div', { class: 'tile-title', text: o.title }),
          el('div', { class: 'tile-status', text: STATUS_LABELS[o.status] })
        )
      );
    });
    return grid;
  }

  function renderDocLinks(doc) {
    const links = el('div', { class: 'doc-links' });
    if (doc.projectwise_url) {
      links.appendChild(
        el('a', {
          class: 'doc-link',
          href: doc.projectwise_url,
          text: 'Open'
        })
      );
    }
    if (doc.projectwise_web_url) {
      links.appendChild(
        el('a', {
          class: 'doc-link',
          href: doc.projectwise_web_url,
          target: '_blank',
          rel: 'noopener',
          text: 'Web'
        })
      );
    }
    if (!doc.projectwise_url && !doc.projectwise_web_url) {
      links.appendChild(el('span', { class: 'doc-link disabled', text: 'Not filed' }));
    }
    return links;
  }

  function renderLayer(layerKey, layerDocs) {
    const layer = el(
      'div',
      { class: 'layer' },
      el('div', { class: 'layer-label', text: LAYER_LABELS[layerKey] })
    );

    if (layerDocs.length === 0) {
      layer.appendChild(
        el(
          'div',
          { class: 'layer-doc' },
          el(
            'div',
            { class: 'layer-doc-info' },
            el('div', {
              class: 'layer-doc-meta',
              text: 'No documents mapped at this layer.'
            })
          )
        )
      );
      return layer;
    }

    layerDocs.forEach(entry => {
      const doc = entry.doc;
      const info = el(
        'div',
        { class: 'layer-doc-info' },
        el('div', { class: 'layer-doc-id', text: doc.id }),
        el('div', { class: 'layer-doc-title', text: doc.title })
      );
      const metaParts = [];
      if (doc.revision) metaParts.push(doc.revision);
      if (doc.date_filed) metaParts.push('Filed ' + doc.date_filed);
      if (doc.status_note) metaParts.push(doc.status_note);
      if (metaParts.length > 0) {
        info.appendChild(
          el('div', { class: 'layer-doc-meta', text: metaParts.join(' | ') })
        );
      }
      layer.appendChild(
        el('div', { class: 'layer-doc' }, info, renderDocLinks(doc))
      );
    });

    return layer;
  }

  function renderDetail(obligationId) {
    const o = obligations.find(x => x.id === obligationId);
    if (!o) {
      return el('div', { class: 'empty-state', text: 'Obligation not found.' });
    }

    const container = el('div');

    const header = el(
      'div',
      { class: 'detail-header' },
      el('button', {
        class: 'back-link',
        onclick: function () {
          state.selectedObligationId = null;
          render();
        },
        text: '\u2190 Back to coverage view'
      }),
      el('div', {
        class: 'detail-regulation',
        text: o.regulation ? o.regulation.name : ''
      }),
      el('h2', { class: 'detail-title', text: o.title }),
      el('div', { class: 'detail-control-id', text: o.control_id || o.id })
    );
    if (o.description) {
      header.appendChild(el('div', { class: 'detail-description', text: o.description }));
    }
    container.appendChild(header);

    // Meta row
    const meta = el('div', { class: 'detail-meta' });
    meta.appendChild(
      el(
        'div',
        { class: 'detail-meta-item' },
        el('div', { class: 'detail-meta-label', text: 'Status' }),
        el('span', {
          class: 'status-badge status-' + o.status,
          text: STATUS_LABELS[o.status]
        })
      )
    );
    if (o.role) {
      const roleValue = o.role.iso_clause
        ? o.role.name + ' (ISO 27001 Clause ' + o.role.iso_clause + ')'
        : o.role.name;
      meta.appendChild(
        el(
          'div',
          { class: 'detail-meta-item' },
          el('div', { class: 'detail-meta-label', text: 'Accountable role' }),
          el('div', { class: 'detail-meta-value', text: roleValue })
        )
      );
    }
    if (o.regulation && o.regulation.obligation_type) {
      meta.appendChild(
        el(
          'div',
          { class: 'detail-meta-item' },
          el('div', { class: 'detail-meta-label', text: 'Obligation type' }),
          el('div', {
            class: 'detail-meta-value',
            text: o.regulation.obligation_type.replace(/_/g, ' ')
          })
        )
      );
    }
    container.appendChild(meta);

    // Traceability across layers
    const traceability = el(
      'div',
      { class: 'traceability' },
      el('div', { class: 'traceability-title', text: 'Four-layer traceability' })
    );

    const docsByLayer = { requirement: [], design: [], specification: [], verification: [] };
    if (o.mapping) {
      (o.mapping.documents || []).forEach(entry => {
        const doc = documentsById[entry.document_id];
        if (!doc) return;
        const layer = entry.layer || doc.layer || 'verification';
        if (docsByLayer[layer]) {
          docsByLayer[layer].push({ doc: doc, mappingEntry: entry });
        }
      });
    }

    LAYER_ORDER.forEach(l => {
      traceability.appendChild(renderLayer(l, docsByLayer[l]));
    });
    container.appendChild(traceability);

    if (o.mapping && o.mapping.notes) {
      container.appendChild(
        el(
          'div',
          { class: 'notes' },
          el('div', { class: 'notes-label', text: 'Verification notes' }),
          o.mapping.notes
        )
      );
    }

    return container;
  }

  function renderFooter() {
    return el(
      'div',
      { class: 'footer' },
      el('div', {
        class: 'build-info',
        text: 'Built with compliance-catalog v' + data.build_metadata.tool_version
      }),
      el('div', {
        text: 'Static HTML. All content embedded. Links open in the source system.'
      })
    );
  }

  function render() {
    const app = document.getElementById('app');
    app.innerHTML = '';
    app.appendChild(renderHeader());

    if (state.selectedObligationId) {
      app.appendChild(renderDetail(state.selectedObligationId));
    } else {
      app.appendChild(renderFilters());
      app.appendChild(renderOverview());
    }

    app.appendChild(renderFooter());
    window.scrollTo(0, 0);
  }

  render();
})();
