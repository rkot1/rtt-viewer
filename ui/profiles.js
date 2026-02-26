// Profile management — modals, ELF extraction, CRUD

const invoke = window.__TAURI__.core.invoke;

let openDialog;
try { openDialog = window.__TAURI__.dialog?.open; } catch (e) {}

let profiles = [];
let editingProfile = null;

const $ = s => document.querySelector(s);

export function getProfiles() { return profiles; }
export function getSelectedProfile() {
  const name = $('#profileSelect').value;
  return profiles.find(p => p.name === name) || null;
}

export async function init() {
  profiles = await invoke('get_profiles');
  renderSelect();
  bindEvents();
}

function renderSelect() {
  $('#profileSelect').innerHTML = '<option value="">— profile —</option>' +
    profiles.map(p => {
      const coreStr = p.core ? ', core ' + p.core : '';
      return `<option value="${esc(p.name)}">${esc(p.name)} (${esc(p.chip)}${coreStr})</option>`;
    }).join('');
}

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function renderProfileList() {
  const list = $('#profileList');
  if (profiles.length === 0) {
    list.innerHTML = '<div style="color:var(--dim);text-align:center;padding:16px;">No profiles yet</div>';
    return;
  }
  list.innerHTML = profiles.map(p => `
    <div class="profile-item" data-name="${esc(p.name)}">
      <span class="prof-name">${esc(p.name)}</span>
      <span class="prof-chip">${esc(p.chip)}${p.core ? ' core ' + p.core : ''}</span>
      <span class="prof-addr">${p.rtt_address ? esc(p.rtt_address) : 'scan RAM'}</span>
      <div class="prof-actions">
        <button class="prof-btn edit" data-name="${esc(p.name)}">edit</button>
        <button class="prof-btn del" data-name="${esc(p.name)}">✕</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.prof-btn.edit').forEach(el => {
    el.addEventListener('click', e => { e.stopPropagation(); openEditModal(el.dataset.name); });
  });

  list.querySelectorAll('.prof-btn.del').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Delete profile "${el.dataset.name}"?`)) return;
      profiles = await invoke('delete_profile', { name: el.dataset.name });
      renderProfileList();
      renderSelect();
    });
  });
}

function openProfilesModal() {
  renderProfileList();
  $('#profilesModal').classList.add('open');
}

function openEditModal(existingName) {
  editingProfile = existingName;
  const prof = existingName ? profiles.find(p => p.name === existingName) : null;

  $('#editTitle').textContent = prof ? 'Edit Profile' : 'New Profile';
  $('#editSubtitle').textContent = prof ? `Editing "${prof.name}"` : 'Create a new target configuration';
  $('#profName').value = prof ? prof.name : '';
  $('#profName').disabled = !!prof;
  $('#profChip').value = prof ? prof.chip : '';
  $('#profCore').value = prof ? (prof.core || 0) : 0;
  $('#profAddr').value = prof ? (prof.rtt_address || '') : '';
  $('#elfPath').textContent = prof?.elf_path || '';
  $('#elfSuccess').style.display = 'none';
  $('#elfError').style.display = 'none';
  $('#editError').style.display = 'none';
  $('#btnDeleteProfile').style.display = prof ? 'inline-block' : 'none';

  $('#profilesModal').classList.remove('open');
  $('#editModal').classList.add('open');
  if (!prof) $('#profName').focus();
}

async function saveProfile() {
  const name = $('#profName').value.trim();
  const chip = $('#profChip').value.trim();
  if (!name || !chip) {
    $('#editError').textContent = 'Name and chip are required';
    $('#editError').style.display = 'block';
    return;
  }
  const addr = $('#profAddr').value.trim() || null;
  const core = parseInt($('#profCore').value) || 0;
  const elfPath = $('#elfPath').textContent || null;

  try {
    profiles = await invoke('save_profile', {
      profile: { name, chip, rtt_address: addr, elf_path: elfPath, core }
    });
    renderSelect();
    $('#profileSelect').value = name;
    $('#editModal').classList.remove('open');
    openProfilesModal();
  } catch (e) {
    $('#editError').textContent = e;
    $('#editError').style.display = 'block';
  }
}

async function deleteCurrentProfile() {
  if (!editingProfile) return;
  if (!confirm(`Delete profile "${editingProfile}"?`)) return;
  profiles = await invoke('delete_profile', { name: editingProfile });
  renderSelect();
  $('#editModal').classList.remove('open');
  openProfilesModal();
}

async function pickElf() {
  $('#elfSuccess').style.display = 'none';
  $('#elfError').style.display = 'none';

  let path;
  if (openDialog) {
    path = await openDialog({
      multiple: false,
      filters: [{ name: 'ELF', extensions: ['elf', 'out', ''] }],
    });
  } else {
    path = prompt('Enter full path to .elf file:');
  }
  if (!path) return;

  $('#elfPath').textContent = path;
  $('#btnPickElf').textContent = 'Extracting…';
  $('#btnPickElf').disabled = true;

  try {
    const info = await invoke('extract_rtt_address_from_elf', { elfPath: path });
    $('#profAddr').value = info.rtt_address;

    let msg = `Found _SEGGER_RTT at ${info.rtt_address}`;
    if (info.chip_hint) {
      msg += ` · Detected: ${info.chip_hint}`;
      // Auto-fill chip if empty
      if (!$('#profChip').value.trim()) {
        $('#profChip').value = info.chip_hint;
      }
    }
    $('#elfSuccess').textContent = msg;
    $('#elfSuccess').style.display = 'block';
  } catch (e) {
    $('#elfError').textContent = '' + e;
    $('#elfError').style.display = 'block';
  } finally {
    $('#btnPickElf').textContent = 'Browse for .elf file…';
    $('#btnPickElf').disabled = false;
  }
}

function bindEvents() {
 $('#btnProfiles').addEventListener('click', openProfilesModal);
  $('#btnAddProfile').addEventListener('click', () => openEditModal(null));
  $('#editCancel').addEventListener('click', () => { $('#editModal').classList.remove('open'); openProfilesModal(); });
  $('#editSave').addEventListener('click', saveProfile);
  $('#btnDeleteProfile').addEventListener('click', deleteCurrentProfile);
  $('#btnPickElf').addEventListener('click', pickElf);

  // Close buttons
  $('#closeProfilesModal').addEventListener('click', () => $('#profilesModal').classList.remove('open'));
  $('#closeEditModal').addEventListener('click', () => { $('#editModal').classList.remove('open'); openProfilesModal(); });
}

export function closeModals() {
  $('#editModal').classList.remove('open');
  $('#profilesModal').classList.remove('open');
}