/**
 * Labroute - Report Ledger Submission Controller (Fixed & Synchronized)
 * Handles Word paste parsing, tag pills, dynamic tables, multi-diagram uploads,
 * and producing downloadable files for the static archive.
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
            chip.appendChild(document.createTextNode(`${tag} `));

            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'tag-remove';
            removeButton.dataset.idx = idx;
            removeButton.textContent = '×';
            chip.appendChild(removeButton);

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
            chip.appendChild(document.createTextNode(`${item} `));

            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'tag-remove';
            removeButton.dataset.appIdx = idx;
            removeButton.textContent = '×';
            chip.appendChild(removeButton);

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
        if (!container) return;

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
            <input type="text" class="input-text list-input" placeholder="Enter details..." />
            <button type="button" class="btn-icon-danger" title="Remove row"><span class="material-symbols-outlined">delete</span></button>
        `;

        // Assign through the DOM instead of an HTML attribute so TeX characters
        // such as &, <, and backslashes are preserved exactly.
        const input = row.querySelector('.list-input');
        input.value = value;
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
        if (!container) return;
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
        if (!qaList) return;
        const card = document.createElement('div');
        card.className = 'qa-item-card';
        const count = qaList.children.length + 1;

        card.innerHTML = `
            <div class="qa-card-top">
                <label class="qa-title-label">QUESTION ${count}</label>
                <button type="button" class="btn-icon-danger" title="Delete Question"><span class="material-symbols-outlined">delete</span></button>
            </div>
            <input type="text" class="input-text qa-question-input" placeholder="Enter question..." />
            
            <label class="qa-ans-label">ANSWER</label>
            <textarea class="input-textarea qa-answer-input" rows="2" placeholder="Type answer here..."></textarea>
        `;
        card.querySelector('.qa-question-input').value = q;
        card.querySelector('.qa-answer-input').value = a;

        card.querySelector('.btn-icon-danger').addEventListener('click', () => {
            card.remove();
            reindexQaCards();
        });

        qaList.appendChild(card);
    }

    function reindexQaCards() {
        if (!qaList) return;
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
    let tableRows = [['', '', '']];

    const tableHeaderRow = document.getElementById('tableHeaderRow');
    const tableBody = document.getElementById('tableBody');

    function renderTable() {
        if (!tableHeaderRow || !tableBody) return;

        tableHeaderRow.innerHTML = '';
        tableHeaders.forEach((headerText, colIdx) => {
            const th = document.createElement('th');
            th.innerHTML = `
                <div class="header-cell-wrapper">
                  <input type="text" class="th-input" data-col="${colIdx}" />
                  ${tableHeaders.length > 1 ? `<button type="button" class="btn-col-del" data-col="${colIdx}" title="Delete Column"><span class="material-symbols-outlined">close</span></button>` : ''}
                </div>
            `;
            th.querySelector('.th-input').value = headerText;
            tableHeaderRow.appendChild(th);
        });
        tableHeaderRow.innerHTML += `<th class="th-action"></th>`;

        // 2. Render Rows
        tableBody.innerHTML = '';
        tableRows.forEach((row, rowIdx) => {
            const tr = document.createElement('tr');
            row.forEach((cellVal, colIdx) => {
                const td = document.createElement('td');
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'cell-input';
                input.dataset.row = rowIdx;
                input.dataset.col = colIdx;
                input.value = cellVal;
                td.appendChild(input);
                tr.appendChild(td);
            });
            const actionCell = document.createElement('td');
            actionCell.innerHTML = `<button type="button" class="btn-row-del" data-row="${rowIdx}" title="Delete Row"><span class="material-symbols-outlined">delete</span></button>`;
            tr.appendChild(actionCell);
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

    tableHeaderRow?.addEventListener('input', (e) => {
        if (e.target.classList.contains('th-input')) {
            const col = e.target.getAttribute('data-col');
            tableHeaders[col] = e.target.value;
        }
    });

    tableHeaderRow?.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-col-del');
        if (btn) {
            const col = parseInt(btn.getAttribute('data-col'), 10);
            tableHeaders.splice(col, 1);
            tableRows.forEach(row => row.splice(col, 1));
            renderTable();
        }
    });

    tableBody?.addEventListener('input', (e) => {
        if (e.target.classList.contains('cell-input')) {
            const row = e.target.getAttribute('data-row');
            const col = e.target.getAttribute('data-col');
            tableRows[row][col] = e.target.value;
        }
    });

    tableBody?.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-row-del');
        if (btn) {
            const row = parseInt(btn.getAttribute('data-row'), 10);
            tableRows.splice(row, 1);
            renderTable();
        }
    });

    // =========================================================================
    // 6. SETUP DIAGRAMS & GRAPH UPLOAD CONTROLLER
    // =========================================================================
    
    // Dynamic Diagram Cards Handler
    const diagramsList = document.getElementById('diagramsUploadList');
    const addDiagramBtn = document.getElementById('addDiagramBtn');

    function bindDiagramCardEvents(card) {
        const input = card.querySelector('.diagram-file-input');
        const label = card.querySelector('.filename-label');
        const dropzone = card.querySelector('.file-dropzone');

        if (input && label && dropzone) {
            input.addEventListener('change', () => {
                if (input.files && input.files[0]) {
                    label.textContent = `Attached: ${input.files[0].name} (${(input.files[0].size / 1024).toFixed(1)} KB)`;
                    label.style.color = '#10b981';
                }
            });

            ['dragover', 'dragenter'].forEach(evt => dropzone.addEventListener(evt, () => dropzone.classList.add('dragover')));
            ['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, () => dropzone.classList.remove('dragover')));
        }
    }

    // Bind initial diagram card
    diagramsList?.querySelectorAll('.upload-item-card').forEach(bindDiagramCardEvents);

    // Add another diagram card
    addDiagramBtn?.addEventListener('click', () => {
        const cardCount = diagramsList.children.length + 1;
        const newCard = document.createElement('div');
        newCard.className = 'upload-item-card';
        newCard.style.marginTop = '1rem';
        newCard.innerHTML = `
            <div class="file-dropzone">
                <input type="file" class="file-hidden-input diagram-file-input" accept="image/png, image/jpeg, image/svg+xml" />
                <span class="material-symbols-outlined dropzone-icon">cloud_upload</span>
                <p class="dropzone-text">Upload Setup Diagram ${cardCount}</p>
                <span class="dropzone-subtext filename-label">Supports JPG, PNG, SVG</span>
            </div>
            <input type="text" class="input-text caption-input diagram-caption-input" placeholder="Caption (e.g. Figure 1.${cardCount}: Schematic layout)..." />
        `;
        diagramsList.appendChild(newCard);
        bindDiagramCardEvents(newCard);
    });

    // Single Graph Dropzone Binder
    function bindSingleDropzone(dropzoneId, inputId, labelId) {
        const dropzone = document.getElementById(dropzoneId);
        const input = document.getElementById(inputId);
        const label = document.getElementById(labelId);

        if (!input || !dropzone || !label) return;

        input.addEventListener('change', () => {
            if (input.files && input.files[0]) {
                label.textContent = `Attached: ${input.files[0].name} (${(input.files[0].size / 1024).toFixed(1)} KB)`;
                label.style.color = '#10b981';
            }
        });

        ['dragover', 'dragenter'].forEach(evt => dropzone.addEventListener(evt, () => dropzone.classList.add('dragover')));
        ['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, () => dropzone.classList.remove('dragover')));
    }

    bindSingleDropzone('graphDropzone', 'graphFileInput', 'graphFileName');

    // =========================================================================
    // 7. LIVE LATEX PREVIEW
    // =========================================================================
    function setupTheoryFormulaPreview() {
        const theoryInput = document.getElementById('theoryText');
        const preview = document.getElementById('theoryFormulaPreview');
        if (!theoryInput || !preview) return;

        let previewTimer;
        const updatePreview = () => {
            // Use textContent so TeX is previewed as data, never as author HTML.
            preview.textContent = theoryInput.value || 'Your theory and formulas will appear here.';
            window.LabrouteMath?.typeset(preview);
        };

        theoryInput.addEventListener('input', () => {
            window.clearTimeout(previewTimer);
            previewTimer = window.setTimeout(updatePreview, 200);
        });

        updatePreview();
        // The first update can occur before the deferred MathJax file is ready.
        window.addEventListener('load', updatePreview, { once: true });
    }

    setupTheoryFormulaPreview();

    // =========================================================================
    // 8. INITIALIZE DEFAULT FORM STATE
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

    // =========================================================================
    // 9. JSON COMPILATION & SUBMISSION
    // =========================================================================
    function extractFormData() {
        const code = document.getElementById('courseCode')?.value.trim() || '';
        const title = document.getElementById('experimentTitle')?.value.trim() || '';
        const department = document.getElementById('department')?.value || 'general';
        const level = document.getElementById('academicLevel')?.value || '100';
        const verified = document.querySelector('input[name="verified"]:checked')?.value === 'true';

        const cleanId = (code + '-' + title)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');

        // Extract objectives, procedures, precautions, learnings
        const getValues = (containerId) => {
            const arr = [];
            document.querySelectorAll(`#${containerId} .list-input`).forEach(input => {
                const val = input.value;
                if (val.trim()) arr.push(val);
            });
            return arr;
        };

        // Extract Q&A
        const questions = [];
        document.querySelectorAll('#qaList .qa-item-card').forEach(card => {
            const q = card.querySelector('.qa-question-input')?.value || '';
            const a = card.querySelector('.qa-answer-input')?.value || '';
            if (q.trim() || a.trim()) questions.push({ question: q, answer: a });
        });

        // Extract All Dynamic Diagrams
        const diagrams = [];
        document.querySelectorAll('#diagramsUploadList .upload-item-card').forEach((card, i) => {
            const file = card.querySelector('.diagram-file-input')?.files[0];
            const caption = card.querySelector('.diagram-caption-input')?.value.trim();
            if (file || caption) {
                const ext = file ? file.name.split('.').pop() : 'png';
                diagrams.push({
                    src: `assets/lab_images/${cleanId}_diagram_${i + 1}.${ext}`,
                    caption: caption || `Figure 1.${i + 1}`
                });
            }
        });

        // Extract Graph
        const graphFile = document.getElementById('graphFileInput')?.files[0] || null;
        const graphCaption = document.getElementById('graphCaption')?.value.trim() || '';
        const graphExt = graphFile ? graphFile.name.split('.').pop() : 'png';
        const graphs = (graphFile || graphCaption) ? [{
            title: graphCaption || 'Experimental Graph',
            src: `assets/lab_images/${cleanId}_graph.${graphExt}`,
            caption: graphCaption
        }] : [];

        const tableTitle = document.getElementById('tableTitleInput')?.value.trim() || 'Table 1: Experimental Measurements';
        // TeX stays in these strings exactly as authored. JSON.stringify will
        // escape backslashes for valid JSON and JSON.parse restores them when
        // report.html loads the file.
        const getRichText = (id) => document.getElementById(id)?.value || '';

        return {
            id: cleanId || 'report-ledger',
            code: code,
            title: title,
            department: department,
            level: level,
            session: "2025/2026",
            tags: [...topicTags],
            verified: verified,
            file: `${department}/${cleanId}.json`,
            content: {
                aim: getRichText('aimText'),
                objectives: getValues('objectivesList'),
                apparatus: [...apparatusTags],
                theory: {
                    text: getRichText('theoryText'),
                    diagrams: diagrams
                },
                tables: [
                    {
                        title: tableTitle,
                        headers: [...tableHeaders],
                        rows: tableRows.map(row => [...row])
                    }
                ],
                graphs: graphs,
                procedure: getValues('procedureList'),
                precautions: getValues('precautionsList'),
                discussion: getRichText('discussionText'),
                conclusion: getRichText('conclusionText'),
                questions: questions,
                learnings: getValues('learningsList')
            }
        };
    }

    function extractMetadata(reportJSON) {
        return {
            id: reportJSON.id,
            code: reportJSON.code,
            title: reportJSON.title,
            department: reportJSON.department,
            level: reportJSON.level,
            session: reportJSON.session,
            tags: reportJSON.tags,
            file: reportJSON.file,
            verified: reportJSON.verified
        };
    }

    // =========================================================================
    // 10. SAVE DRAFT (Local Storage)
    // =========================================================================
    document.getElementById('saveDraftBtn')?.addEventListener('click', () => {
        const data = extractFormData();
        localStorage.setItem('Labroute_report_draft', JSON.stringify(data));
        alert('Draft saved locally in your browser!');
    });

    // =========================================================================
    // 11. SUBMIT TO ARCHIVE (Download Pipeline)
    // =========================================================================
    function downloadFile(filename, blob) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    function downloadJSON(filename, dataObj) {
        const jsonString = JSON.stringify(dataObj, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        downloadFile(filename, blob);
    }

    const form = document.getElementById('reportLedgerForm');

    form?.addEventListener('submit', (e) => {
        e.preventDefault();

        const reportJSON = extractFormData();

        if (!reportJSON.code || !reportJSON.title) {
            alert('Please fill in Course Code and Experiment Title before submitting.');
            return;
        }

        const metadata = extractMetadata(reportJSON);
        const reportFilename = `${reportJSON.id}.json`;
        const metaFilename = `${reportJSON.id}-meta.json`;

        const graphFile = document.getElementById('graphFileInput')?.files[0] || null;

        // Build the download queue
        const downloadQueue = [
            () => downloadJSON(reportFilename, reportJSON),
            () => downloadJSON(metaFilename, metadata)
        ];

        // Queue all attached diagram images
        const downloadedImages = [];
        document.querySelectorAll('#diagramsUploadList .upload-item-card').forEach((card, i) => {
            const diagFile = card.querySelector('.diagram-file-input')?.files[0];
            if (diagFile) {
                const filename = `${reportJSON.id}_diagram_${i + 1}.${diagFile.name.split('.').pop()}`;
                downloadedImages.push(filename);
                downloadQueue.push(() => downloadFile(filename, diagFile));
            }
        });

        // Queue attached graph image
        if (graphFile) {
            const graphFilename = `${reportJSON.id}_graph.${graphFile.name.split('.').pop()}`;
            downloadedImages.push(graphFilename);
            downloadQueue.push(() => downloadFile(graphFilename, graphFile));
        }

        downloadQueue.forEach((triggerDownload, i) => setTimeout(triggerDownload, i * 250));

        setTimeout(() => {
            let msg = `Downloaded ${downloadQueue.length} file(s):\n\n` +
                      `1) ${reportFilename} → move into: content/reports/${reportJSON.department}/\n` +
                      `2) ${metaFilename} → copy and paste into: content/reports/index.json\n`;

            if (downloadedImages.length) {
                msg += `\nImages:\n` + downloadedImages.map(img => `• ${img} → move into: assets/lab_images/`).join('\n');
            }

            alert(msg);
        }, downloadQueue.length * 250);
    });

});