/**
 * MyEla - Report Ledger Submission Controller
 * Handles Word paste parsing, tag pills, dynamic tables, and JSON generation.
 */

document.addEventListener('DOMContentLoaded', () => {

    // State arrays for Tag pills
    let topicTags = [];
    let apparatusTags = [];

    // =========================================================================
    // 1. MS WORD CLIPBOARD PARSERS
    // =========================================================================
    function parseWordList(pastedText) {
        return pastedText
            .split(/\r?\n/)
            .map(line => line.replace(/^[\s\d.\-*•○)]+/, '').trim())
            .filter(line => line.length > 0);
    }

    function parseDelimitedText(pastedText) {
        return pastedText
            .split(/[\r\n,]+/)
            .map(item => item.replace(/^[\s\d.\-*•○)]+/, '').trim())
            .filter(item => item.length > 0);
    }

    // =========================================================================
    // 2. TAG PILL BUILDERS (TOPIC TAGS & APPARATUS)
    // =========================================================================
    const topicContainer = document.getElementById('topicTagsContainer');
    const topicInput = document.getElementById('topicTagInput');

    function renderTopicTags() {
        // Clear existing chips, keep the input element
        topicContainer.querySelectorAll('.tag-chip').forEach(el => el.remove());

        topicTags.forEach((tag, idx) => {
            const chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.innerHTML = `${tag} <button type="button" class="tag-remove" data-idx="${idx}">&times;</button>`;
            topicContainer.insertBefore(chip, topicInput);
        });
    }

    if (topicInput) {
        topicInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                let val = topicInput.value.trim();
                if (val) {
                    if (!val.startsWith('#')) val = '#' + val;
                    if (!topicTags.includes(val)) topicTags.push(val);
                    topicInput.value = '';
                    renderTopicTags();
                }
            }
        });

        topicContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('tag-remove')) {
                const idx = e.target.getAttribute('data-idx');
                topicTags.splice(idx, 1);
                renderTopicTags();
            }
        });
    }

    // Apparatus Tag Box
    const apparatusContainer = document.getElementById('apparatusContainer');
    const apparatusInput = document.getElementById('apparatusInput');

    function renderApparatusTags() {
        apparatusContainer.querySelectorAll('.tag-chip').forEach(el => el.remove());

        apparatusTags.forEach((item, idx) => {
            const chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.innerHTML = `${item} <button type="button" class="tag-remove" data-app-idx="${idx}">&times;</button>`;
            apparatusContainer.insertBefore(chip, apparatusInput);
        });
    }

    if (apparatusInput) {
        // Paste handler for apparatus
        apparatusInput.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData).getData('text');
            const items = parseDelimitedText(text);
            items.forEach(item => {
                if (!apparatusTags.includes(item)) apparatusTags.push(item);
            });
            apparatusInput.value = '';
            renderApparatusTags();
        });

        apparatusInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const val = apparatusInput.value.trim();
                if (val && !apparatusTags.includes(val)) {
                    apparatusTags.push(val);
                    apparatusInput.value = '';
                    renderApparatusTags();
                }
            }
        });

        apparatusContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('tag-remove')) {
                const idx = e.target.getAttribute('data-app-idx');
                apparatusTags.splice(idx, 1);
                renderApparatusTags();
            }
        });
    }

    // =========================================================================
    // 3. DYNAMIC LIST BUILDERS (OBJECTIVES, PROCEDURE, PRECAUTIONS, LEARNINGS)
    // =========================================================================
    function createListRow(containerId, value = '', isNumbered = true, isBullet = false) {
        const container = document.getElementById(containerId);
        const row = document.createElement('div');
        row.className = 'list-item-row';

        let prefixHTML = '';
        if (isNumbered) {
            prefixHTML = `<span class="row-num">${container.children.length + 1}.</span>`;
        } else if (isBullet) {
            prefixHTML = `<span class="row-bullet">○</span>`;
        } else {
            prefixHTML = `<span class="material-symbols-outlined row-icon-bullet">subdirectory_arrow_right</span>`;
        }

        row.innerHTML = `
      ${prefixHTML}
      <input type="text" class="input-text list-input" value="${value.replace(/"/g, '&quot;')}" placeholder="Enter details..." />
      <button type="button" class="btn-icon-danger" title="Remove row"><span class="material-symbols-outlined">delete</span></button>
    `;

        // Smart Paste on row input
        const input = row.querySelector('.list-input');
        input.addEventListener('paste', (e) => {
            const text = (e.clipboardData || window.clipboardData).getData('text');
            const lines = parseWordList(text);
            if (lines.length > 1) {
                e.preventDefault();
                input.value = lines[0];
                for (let i = 1; i < lines.length; i++) {
                    createListRow(containerId, lines[i], isNumbered, isBullet);
                }
            }
        });

        // Delete row handler
        row.querySelector('.btn-icon-danger').addEventListener('click', () => {
            row.remove();
            if (isNumbered) reindexRows(containerId);
        });

        container.appendChild(row);
    }

    function reindexRows(containerId) {
        const container = document.getElementById(containerId);
        container.querySelectorAll('.list-item-row').forEach((row, i) => {
            const numSpan = row.querySelector('.row-num');
            if (numSpan) numSpan.textContent = `${i + 1}.`;
        });
    }

    // Bind Add Buttons
    document.getElementById('addObjectiveBtn')?.addEventListener('click', () => createListRow('objectivesList', '', true, false));
    document.getElementById('addProcedureBtn')?.addEventListener('click', () => createListRow('procedureList', '', true, false));
    document.getElementById('addPrecautionBtn')?.addEventListener('click', () => createListRow('precautionsList', '', false, true));
    document.getElementById('addLearningBtn')?.addEventListener('click', () => createListRow('learningsList', '', false, false));

    // =========================================================================
    // 4. Q&A PAIR BUILDER
    // =========================================================================
    const qaList = document.getElementById('qaList');

    function addQaCard(q = '', a = '') {
        const card = document.createElement('div');
        card.className = 'qa-item-card';
        const count = qaList.children.length + 1;

        card.innerHTML = `
      <div class="qa-card-top">
          <label class="qa-title-label">QUESTION ${count}</label>
          <button type="button" class="btn-icon-danger" title="Delete Question"><span class="material-symbols-outlined">delete</span></button>
      </div>
      <input type="text" class="input-text qa-question-input" value="${q.replace(/"/g, '&quot;')}" placeholder="Enter question..." />
      
      <label class="qa-ans-label">ANSWER</label>
      <textarea class="input-textarea qa-answer-input" rows="2" placeholder="Type answer here...">${a}</textarea>
    `;

        card.querySelector('.btn-icon-danger').addEventListener('click', () => {
            card.remove();
            reindexQaCards();
        });

        qaList.appendChild(card);
    }

    function reindexQaCards() {
        qaList.querySelectorAll('.qa-item-card').forEach((card, i) => {
            const label = card.querySelector('.qa-title-label');
            if (label) label.textContent = `QUESTION ${i + 1}`;
        });
    }

    document.getElementById('addQaBtn')?.addEventListener('click', () => addQaCard());

    // =========================================================================
    // 5. DYNAMIC TABLE OF VALUES BUILDER
    // =========================================================================
    let tableHeaders = ["Parameter 1", "Parameter 2", "Parameter 3"];
    let tableRows = [[1, 2, 3]];

    const tableHeaderRow = document.getElementById('tableHeaderRow');
    const tableBody = document.getElementById('tableBody');

    function renderTable() {
        // 1. Render Headers
        tableHeaderRow.innerHTML = '';
        tableHeaders.forEach((headerText, colIdx) => {
            const th = document.createElement('th');
            th.innerHTML = `
        <div class="header-cell-wrapper">
          <input type="text" class="th-input" value="${headerText}" data-col="${colIdx}" />
          ${tableHeaders.length > 1 ? `<button type="button" class="btn-col-del" data-col="${colIdx}" title="Delete Column"><span class="material-symbols-outlined">close</span></button>` : ''}
        </div>
      `;
            tableHeaderRow.appendChild(th);
        });
        tableHeaderRow.innerHTML += `<th class="th-action"></th>`;

        // 2. Render Rows
        tableBody.innerHTML = '';
        tableRows.forEach((row, rowIdx) => {
            const tr = document.createElement('tr');
            row.forEach((cellVal, colIdx) => {
                tr.innerHTML += `<td><input type="text" class="cell-input" value="${cellVal}" data-row="${rowIdx}" data-col="${colIdx}" /></td>`;
            });
            tr.innerHTML += `<td><button type="button" class="btn-row-del" data-row="${rowIdx}" title="Delete Row"><span class="material-symbols-outlined">delete</span></button></td>`;
            tableBody.appendChild(tr);
        });
    }

    // Column / Row Table Event Handlers
    document.getElementById('addColumnBtn')?.addEventListener('click', () => {
        tableHeaders.push(`Var ${tableHeaders.length + 1}`);
        tableRows.forEach(row => row.push(''));
        renderTable();
    });

    document.getElementById('addRowBtn')?.addEventListener('click', () => {
        const newRow = new Array(tableHeaders.length).fill('');
        newRow[0] = String(tableRows.length + 1);
        tableRows.push(newRow);
        renderTable();
    });

    tableHeaderRow.addEventListener('input', (e) => {
        if (e.target.classList.contains('th-input')) {
            const col = e.target.getAttribute('data-col');
            tableHeaders[col] = e.target.value;
        }
    });

    tableHeaderRow.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-col-del');
        if (btn) {
            const col = parseInt(btn.getAttribute('data-col'), 10);
            tableHeaders.splice(col, 1);
            tableRows.forEach(row => row.splice(col, 1));
            renderTable();
        }
    });

    tableBody.addEventListener('input', (e) => {
        if (e.target.classList.contains('cell-input')) {
            const row = e.target.getAttribute('data-row');
            const col = e.target.getAttribute('data-col');
            tableRows[row][col] = e.target.value;
        }
    });

    tableBody.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-row-del');
        if (btn) {
            const row = parseInt(btn.getAttribute('data-row'), 10);
            tableRows.splice(row, 1);
            renderTable();
        }
    });

    // =========================================================================
    // 6. FILE UPLOAD VISUAL FEEDBACK
    // =========================================================================
    function bindDropzone(dropzoneId, inputId, labelId) {
        const dropzone = document.getElementById(dropzoneId);
        const input = document.getElementById(inputId);
        const label = document.getElementById(labelId);

        if (!input) return;

        input.addEventListener('change', () => {
            if (input.files && input.files[0]) {
                label.textContent = `Attached: ${input.files[0].name} (${(input.files[0].size / 1024).toFixed(1)} KB)`;
                label.style.color = '#10b981';
            }
        });

        ['dragover', 'dragenter'].forEach(eventName => {
            dropzone.addEventListener(eventName, () => dropzone.classList.add('dragover'), false);
        });
        ['dragleave', 'drop'].forEach(eventName => {
            dropzone.addEventListener(eventName, () => dropzone.classList.remove('dragover'), false);
        });
    }

    bindDropzone('diagramDropzone', 'diagramFileInput', 'diagramFileName');
    bindDropzone('graphDropzone', 'graphFileInput', 'graphFileName');

    // =========================================================================
    // 7. INITIALIZE DEFAULT FORM STATE
    // =========================================================================
    renderTopicTags();
    renderApparatusTags();
    renderTable();

    // Populate Default List Rows
    createListRow('objectivesList', '', true);

    createListRow('procedureList', '', true);

    createListRow('precautionsList', '', false, true);
    createListRow('learningsList', '', false, false);

    addQaCard('', '');

    createListRow('learningsList', '', false, false);

    // =========================================================================
    // 8. JSON COMPILATION & SUBMISSION
    // =========================================================================
    function extractFormData() {
        const code = document.getElementById('courseCode').value.trim();
        const title = document.getElementById('experimentTitle').value.trim();
        const department = document.getElementById('department').value;
        const level = document.getElementById('academicLevel').value;
        const verified = document.querySelector('input[name="verified"]:checked')?.value === 'true';

        const cleanId = (code + '-' + title)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');

        // Extract objectives, procedures, precautions, learnings
        const getValues = (containerId) => {
            const arr = [];
            document.querySelectorAll(`#${containerId} .list-input`).forEach(input => {
                const val = input.value.trim();
                if (val) arr.push(val);
            });
            return arr;
        };

        // Extract Q&A
        const questions = [];
        document.querySelectorAll('#qaList .qa-item-card').forEach(card => {
            const q = card.querySelector('.qa-question-input')?.value.trim();
            const a = card.querySelector('.qa-answer-input')?.value.trim();
            if (q || a) questions.push({ question: q, answer: a });
        });

        const diagramCaption = document.getElementById('diagramCaption').value.trim();
        const graphCaption = document.getElementById('graphCaption').value.trim();
        const tableTitle = document.getElementById('tableTitleInput').value.trim() || 'Table 1: Experimental Measurements';

        // Structured Report JSON
        return {
            id: cleanId || 'report-ledger',
            code: code,
            title: title,
            department: department,
            level: level,
            session: "2023/2024",
            tags: [...topicTags],
            verified: verified,
            file: `${department}/${cleanId}.json`,
            content: {
                aim: document.getElementById('aimText').value.trim(),
                objectives: getValues('objectivesList'),
                apparatus: [...apparatusTags],
                theory: {
                    text: document.getElementById('theoryText').value.trim(),
                    diagrams: diagramCaption ? [{ src: `assets/lab_images/${cleanId}_diagram.png`, caption: diagramCaption }] : []
                },
                tables: [
                    {
                        title: tableTitle,
                        headers: [...tableHeaders],
                        rows: tableRows.map(row => [...row])
                    }
                ],
                graphs: graphCaption ? [{ title: graphCaption, src: `assets/lab_images/${cleanId}_graph.png`, caption: graphCaption }] : [],
                procedure: getValues('procedureList'),
                precautions: getValues('precautionsList'),
                discussion: document.getElementById('discussionText').value.trim(),
                conclusion: document.getElementById('conclusionText').value.trim(),
                questions: questions,
                learnings: getValues('learningsList')
            }
        };
    }

    // 9. Save Draft (Local Storage)
    document.getElementById('saveDraftBtn')?.addEventListener('click', () => {
        const data = extractFormData();
        localStorage.setItem('myela_report_draft', JSON.stringify(data));
        alert('Draft saved locally in your browser!');
    });

    // 10. Submit to Archive (Downloads the JSON File directly)
    const form = document.getElementById('reportLedgerForm');
    form.addEventListener('submit', (e) => {
        e.preventDefault();

        const reportJSON = extractFormData();
        const jsonString = JSON.stringify(reportJSON, null, 2);

        // Auto-trigger file download for the developer / admin to place in content/reports/
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const downloadAnchor = document.createElement('a');
        downloadAnchor.href = url;
        downloadAnchor.download = `${reportJSON.id}.json`;
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
        URL.revokeObjectURL(url);

        alert(`Success! Generated "${reportJSON.id}.json".\n\nPlace this file into: content/reports/${reportJSON.department}/`);
    });

});