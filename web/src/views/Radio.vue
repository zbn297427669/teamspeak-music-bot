<template>
  <div class="radio-page">
    <!-- Search -->
    <div class="search-bar">
      <Icon icon="mdi:magnify" class="search-icon" />
      <input
        v-model="query"
        class="search-input"
        type="search"
        placeholder="搜索电台名称、风格...（留空显示热门电台）"
        @keyup.enter="loadStations"
      />
      <button v-if="query" class="search-clear" @click="clearQuery" title="清空">
        <Icon icon="mdi:close" />
      </button>
    </div>

    <!-- Filters -->
    <div class="filter-row">
      <label class="filter-field">
        <span>国家</span>
        <select v-model="country" @change="loadStations">
          <option value="">全部</option>
          <option v-for="c in topCountries" :key="c.iso_3166_1" :value="c.name">
            {{ c.name }} ({{ c.stationcount }})
          </option>
        </select>
      </label>
      <label class="filter-field">
        <span>分组 / 风格</span>
        <select v-model="tag" @change="loadStations">
          <option value="">全部</option>
          <!-- Imported stations are filtered locally, so their groups are
               listed first: they are what the operator curated. -->
          <optgroup v-if="localGroups.length" label="我的电台分组">
            <option v-for="g in localGroups" :key="`local:${g.name}`" :value="g.name">
              {{ g.name }} ({{ g.count }})
            </option>
          </optgroup>
          <optgroup v-if="topTags.length" label="目录风格">
            <option v-for="t in topTags" :key="t.name" :value="t.name">
              {{ t.name }} ({{ t.stationcount }})
            </option>
          </optgroup>
        </select>
      </label>
      <label class="filter-field">
        <span>最低码率</span>
        <select v-model.number="bitrateMin" @change="loadStations">
          <option :value="0">不限</option>
          <option :value="64">64 kbps</option>
          <option :value="128">128 kbps</option>
          <option :value="192">192 kbps</option>
          <option :value="320">320 kbps</option>
        </select>
      </label>
      <button class="refresh-btn" :disabled="loading" @click="loadStations">
        <Icon icon="mdi:refresh" :class="{ spinning: loading }" /> 刷新列表
      </button>
      <button
        class="refresh-btn"
        :disabled="checkingCount > 0"
        title="重新检测当前列表的在线状态（跳过 60 秒缓存）"
        @click="recheckVisible"
      >
        <Icon icon="mdi:radar" :class="{ spinning: checkingCount > 0 }" />
        {{ checkingCount > 0 ? `检测中 ${checkingCount}` : '检测在线' }}
      </button>
      <button class="refresh-btn" @click="showImport = !showImport">
        <Icon icon="mdi:playlist-plus" /> 导入电台
      </button>
    </div>

    <!-- Import panel -->
    <section v-if="showImport" class="section import-panel">
      <h2 class="section-title">导入本地电台</h2>
      <p class="import-hint">
        粘贴 M3U/M3U8 播放列表内容，或选择本地文件；也可以填一个流地址。按 <code>group-title</code> 自动归类，
        <code>tvg-logo</code> 会作为封面；同一地址重复导入只会更新，不会重复添加。
      </p>
      <!-- Reading the file in the browser (rather than uploading it) keeps the
           server's import contract a single plain-text field, and means a
           playlist never leaves the machine. -->
      <div class="import-file">
        <label class="btn-sm import-file-btn">
          <Icon icon="mdi:file-upload-outline" />
          {{ importFileName || '选择 M3U / M3U8 文件' }}
          <input
            type="file"
            accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain"
            class="import-file-input"
            @change="onPickFile"
          />
        </label>
        <button v-if="importFileName" class="btn-sm" @click="clearPickedFile">清除文件</button>
        <span v-if="importFileStats" class="import-file-stats">{{ importFileStats }}</span>
      </div>
      <textarea
        v-model="importText"
        class="import-textarea"
        rows="7"
        placeholder="#EXTM3U&#10;#EXTINF:-1 group-title=&quot;古典&quot;,电台名称 · 上海&#10;http://example.com/stream.m3u8"
      />
      <div class="import-single">
        <input v-model="importUrl" class="import-input" placeholder="或单个流地址 http(s)://..." />
        <input v-model="importName" class="import-input" placeholder="名称（可留空）" />
        <input v-model="importGroup" class="import-input" placeholder="分组（可留空）" />
        <input v-model="importCover" class="import-input" placeholder="封面图片地址（可留空）" />
      </div>
      <div class="import-actions">
        <button class="btn-sm btn-primary" :disabled="importing" @click="doImport(false)">
          <Icon icon="mdi:download" /> {{ importing ? '导入中…' : '导入' }}
        </button>
        <button class="btn-sm" :disabled="importing" @click="doImport(true)">
          <Icon icon="mdi:eye-outline" /> 预览
        </button>
        <button class="btn-sm" @click="showImport = false">取消</button>
      </div>
      <div v-if="importMessage" class="import-message" :class="importError ? 'is-error' : ''">
        {{ importMessage }}
      </div>
      <div v-if="importSkipped.length" class="import-skipped">
        <div class="import-skipped-title">跳过 {{ importSkipped.length }} 条：</div>
        <div v-for="s in importSkipped" :key="s.line + s.raw" class="import-skipped-row">
          第 {{ s.line }} 行 — {{ s.reason }}
        </div>
      </div>
    </section>

    <!-- Per-station cover editor. A plain overlay rather than <dialog> so it
         stays inside the page's stacking context and inherits the theme. -->
    <div
      v-if="coverStation"
      class="cover-overlay"
      @click.self="closeCoverEditor"
      @keydown.esc="closeCoverEditor"
    >
      <div class="cover-dialog" role="dialog" aria-modal="true" aria-label="设置封面">
        <div class="cover-dialog-head">
          <Icon icon="mdi:image-edit-outline" />
          <span>设置封面</span>
        </div>
        <div class="cover-dialog-body">
          <CoverArt :url="coverDraft.trim()" :size="96" :radius="12" :show-shadow="true" />
          <div class="cover-dialog-fields">
            <div class="cover-dialog-name" :title="coverStation.name">{{ coverStation.name }}</div>
            <input
              v-model="coverDraft"
              class="import-input cover-dialog-input"
              placeholder="https://.../logo.png"
              @keyup.enter="saveCover"
            />
            <div v-if="coverError" class="import-message is-error">{{ coverError }}</div>
            <div class="cover-dialog-actions">
              <button class="btn-sm btn-primary" :disabled="coverSaving" @click="saveCover">
                {{ coverSaving ? '保存中…' : '保存' }}
              </button>
              <button class="btn-sm" :disabled="coverSaving" @click="coverDraft = ''">清空</button>
              <button class="btn-sm" :disabled="coverSaving" @click="closeCoverEditor">取消</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Favorites — pinned above everything else. Both directory results and
         imported stations land here, so this is the one section the user
         curates by hand. It stays mounted when empty (collapsed to a single
         line) so starring the first station does not shift the page. -->
    <section class="section">
      <h2
        class="section-title section-title-toggle"
        @click="toggleSection('favorites', favorites.length === 0)"
      >
        <Icon
          icon="mdi:chevron-right"
          class="section-chevron"
          :class="{ open: !collapsed('favorites', favorites.length === 0) }"
        />
        <Icon icon="mdi:star" class="section-title-icon" />
        收藏电台
        <span class="count-badge">{{ favorites.length }}</span>
      </h2>
      <div v-show="!collapsed('favorites', favorites.length === 0)">
        <div v-if="favorites.length === 0" class="section-empty">
          <Icon icon="mdi:star-outline" class="empty-icon" />
          <span>还没有收藏的电台 —— 把鼠标移到任意卡片上，点 ☆ 收藏，它会置顶到这里</span>
        </div>
        <div v-else class="station-grid">
          <div
            v-for="s in favorites"
            :key="`fav-${s.id}`"
            class="station-card hover-scale"
            :class="[statusClass(s), { active: liveStation?.id === s.id }]"
            @click="playStation(s)"
          >
            <div class="station-cover">
              <CoverArt :url="s.coverUrl" :size="80" :radius="12" :show-shadow="true" />
              <span class="play-overlay"><Icon icon="mdi:play" /></span>
            </div>
            <div class="station-body">
              <div class="station-name" :title="s.name">{{ s.name }}</div>
              <div class="station-meta" :title="stationMeta(s)">{{ stationMeta(s) }}</div>
              <div class="station-tags" :title="stationTags(s)">{{ stationTags(s) }}</div>
              <div class="station-footer">
                <span class="station-state" :class="statusOf(s).state" :title="statusTitle(s)">
                  <span class="state-dot" />{{ statusLabel(s) }}
                </span>
                <div class="station-actions">
                  <button class="station-add station-fav is-on" title="取消收藏" @click.stop="toggleFavorite(s)">
                    <Icon icon="mdi:star" />
                  </button>
                  <button class="station-add" title="添加到队列" @click.stop="addStation(s)">
                    <Icon icon="mdi:playlist-plus" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Locally imported stations, grouped. Like the favorites above it keeps
         its heading when empty (auto-collapsed), so "import one" is always one
         click away rather than hidden behind an absence. -->
    <section class="section">
      <h2
        class="section-title section-title-toggle"
        @click="toggleSection('local', localStations.length === 0)"
      >
        <Icon
          icon="mdi:chevron-right"
          class="section-chevron"
          :class="{ open: !collapsed('local', localStations.length === 0) }"
        />
        我的电台
        <span class="count-badge">{{ filteredLocalStations.length }}</span>
        <span v-if="localFilterActive" class="local-filter-hint">
          已按「{{ tag }}」筛选
          <button class="local-filter-clear" @click.stop="clearLocalFilter">显示全部</button>
        </span>
      </h2>
      <div v-show="!collapsed('local', localStations.length === 0)">
        <div v-if="localStations.length === 0" class="section-empty">
          <Icon icon="mdi:playlist-plus" class="empty-icon" />
          <span>还没有导入的电台 —— 用上方的「导入电台」粘贴 M3U 歌单或流地址</span>
        </div>
        <div v-else-if="filteredLocalStations.length === 0" class="empty-state local-empty">
          <Icon icon="mdi:filter-off-outline" class="empty-icon" />
          <p>{{ localExclusionReason }}</p>
        </div>
        <!-- A group with nothing left after filtering collapses itself: an
             empty header would otherwise still take a row of vertical space. -->
        <div v-for="g in visibleLocalGroups" :key="g.name" class="local-group">
          <div class="local-group-title local-group-toggle" @click="toggleSection(`group:${g.name}`)">
            <Icon
              icon="mdi:chevron-right"
              class="section-chevron"
              :class="{ open: !collapsed(`group:${g.name}`) }"
            />
            {{ g.name }} <span class="local-group-count">{{ g.count }}</span>
          </div>
          <div v-show="!collapsed(`group:${g.name}`)" class="station-grid">
            <div
              v-for="s in localByGroup(g.name)"
              :key="s.id"
              class="station-card hover-scale"
              :class="[statusClass(s), { active: liveStation?.id === s.id }]"
              @click="playStation(s)"
            >
              <div class="station-cover">
                <CoverArt :url="s.coverUrl" :size="80" :radius="12" :show-shadow="true" />
                <span class="play-overlay"><Icon icon="mdi:play" /></span>
              </div>
              <div class="station-body">
                <div class="station-name" :title="s.name">{{ s.name }}</div>
                <div class="station-meta" :title="stationMeta(s)">{{ stationMeta(s) }}</div>
                <div class="station-tags" :title="stationTags(s)">
                  <span class="local-chip">本地</span>{{ stationTags(s) }}
                </div>
                <div class="station-footer">
                  <span class="station-state" :class="statusOf(s).state" :title="statusTitle(s)">
                    <span class="state-dot" />{{ statusLabel(s) }}
                  </span>
                  <div class="station-actions">
                    <button
                      class="station-add station-fav"
                      :class="{ 'is-on': isFavorite(s) }"
                      :title="isFavorite(s) ? '取消收藏' : '收藏'"
                      @click.stop="toggleFavorite(s)"
                    >
                      <Icon :icon="isFavorite(s) ? 'mdi:star' : 'mdi:star-outline'" />
                    </button>
                    <button class="station-add" title="添加到队列" @click.stop="addStation(s)">
                      <Icon icon="mdi:playlist-plus" />
                    </button>
                    <button class="station-add" title="设置封面" @click.stop="openCoverEditor(s)">
                      <Icon icon="mdi:image-edit-outline" />
                    </button>
                    <button class="station-add station-remove" title="移除此电台" @click.stop="removeLocal(s)">
                      <Icon icon="mdi:trash-can-outline" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Now playing (only while a radio station is on air) -->
    <section v-if="liveStation" class="section">
      <h2 class="section-title section-title-toggle" @click="toggleSection('now')">
        <Icon
          icon="mdi:chevron-right"
          class="section-chevron"
          :class="{ open: !collapsed('now') }"
        />
        正在播放
        <span class="live-badge"><span class="live-dot" />直播</span>
      </h2>
      <div v-show="!collapsed('now')" class="now-playing">
        <CoverArt :url="liveStation.coverUrl" :size="80" :radius="10" :show-shadow="true" />
        <div class="now-playing-info">
          <div class="now-playing-name">{{ liveStation.name }}</div>
          <div class="now-playing-artist">
            <template v-if="nowPlaying?.fromStream">
              {{ nowPlaying.title }}
            </template>
            <template v-else-if="nowPlayingLoading">正在读取流信息…</template>
            <template v-else>{{ liveStation.artist }}</template>
          </div>
          <div class="now-playing-meta">
            <span>{{ liveStation.album || '网络电台' }}</span>
            <span class="meta-sep">·</span>
            <span>{{ formatElapsed(store.activeBot?.elapsed ?? 0) }} 已收听</span>
          </div>
        </div>
        <div class="now-playing-actions">
          <button
            v-if="store.activeBot?.playing && !store.activeBot?.paused"
            class="btn-sm"
            @click="store.pause()"
          >
            <Icon icon="mdi:pause" /> 暂停
          </button>
          <button v-else class="btn-sm btn-primary" @click="store.resume()">
            <Icon icon="mdi:play" /> 播放
          </button>
          <button class="btn-sm" @click="store.next()" title="下一个电台">
            <Icon icon="mdi:skip-next" />
          </button>
        </div>
      </div>
    </section>

    <!-- Station grid -->
    <section v-if="!isLocalGroupTag" class="section">
      <h2 class="section-title section-title-toggle" @click="toggleSection('directory')">
        <Icon
          icon="mdi:chevron-right"
          class="section-chevron"
          :class="{ open: !collapsed('directory') }"
        />
        {{ query || country || tag || bitrateMin ? '搜索结果' : '热门电台' }}
        <span class="count-badge">{{ stations.length }}</span>
        <span v-if="!collapsed('directory') && checkingCount > 0" class="checking-hint">
          正在检测在线状态…
        </span>
      </h2>

      <div v-show="!collapsed('directory')">
        <div v-if="error" class="error-box">
          <Icon icon="mdi:alert-circle-outline" /> {{ error }}
        </div>
        <div v-else-if="loading && stations.length === 0" class="skeleton-grid">
          <div v-for="n in 8" :key="n" class="skeleton-card" />
        </div>
        <div v-else-if="stations.length === 0" class="empty-state">
          <Icon icon="mdi:radio-tower" class="empty-icon" />
          <p>没有找到匹配的电台</p>
        </div>
        <div v-else class="station-grid">
          <div
            v-for="s in stations"
            :key="s.id"
            class="station-card hover-scale"
            :class="[statusClass(s), { active: liveStation?.id === s.id }]"
            @click="playStation(s)"
          >
            <div class="station-cover">
              <CoverArt :url="s.coverUrl" :size="80" :radius="12" :show-shadow="true" />
              <span class="play-overlay"><Icon icon="mdi:play" /></span>
            </div>
            <div class="station-body">
              <div class="station-name" :title="s.name">{{ s.name }}</div>
              <div class="station-meta" :title="stationMeta(s)">{{ stationMeta(s) }}</div>
              <div class="station-tags" :title="stationTags(s)">{{ stationTags(s) }}</div>
              <div class="station-footer">
                <span class="station-state" :class="statusOf(s).state" :title="statusTitle(s)">
                  <span class="state-dot" />{{ statusLabel(s) }}
                </span>
                <div class="station-actions">
                  <button
                    class="station-add station-fav"
                    :class="{ 'is-on': isFavorite(s) }"
                    :title="isFavorite(s) ? '取消收藏' : '收藏'"
                    @click.stop="toggleFavorite(s)"
                  >
                    <Icon :icon="isFavorite(s) ? 'mdi:star' : 'mdi:star-outline'" />
                  </button>
                  <button class="station-add" title="添加到队列" @click.stop="addStation(s)">
                    <Icon icon="mdi:playlist-plus" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import CoverArt from '../components/CoverArt.vue';
import { usePlayerStore, type Song } from '../stores/player.js';
import {
  DEFAULT_LOCAL_GROUP,
  filterLocalStations,
  groupCounts,
  isLocalGroupTag as isLocalGroupTagValue,
} from './radioFilter.js';
import {
  decodeCollapsePrefs,
  encodeCollapsePrefs,
  isCollapsed,
  toggleCollapse,
} from './radioSections.js';

interface Facet {
  name: string;
  stationcount: number;
}
interface CountryFacet extends Facet {
  iso_3166_1: string;
}

interface NowPlaying {
  stationId: string;
  title: string;
  artist: string;
  song: string;
  fromStream: boolean;
  fetchedAt: string;
}

/** Mirrors StationStatusResponse in src/web/api/radio.ts. */
type StationState = 'online' | 'offline' | 'unknown';
interface StationStatus {
  id: string;
  url: string;
  online: boolean;
  state: StationState;
  httpStatus: number | null;
  latencyMs: number | null;
  checkedAt: string;
  fromDirectory: boolean;
}

/** Radio rows carry a little more than the generic Song: the directory also
 *  reports codec/bitrate, and imported rows carry their playlist group. */
interface RadioSong extends Song {
  group?: string;
  local?: boolean;
  favorite?: boolean;
  codec?: string;
  bitrate?: number;
}

const store = usePlayerStore();

const query = ref('');
const country = ref('');
const tag = ref('');
const bitrateMin = ref(0);
const stations = ref<RadioSong[]>([]);
const loading = ref(false);
const error = ref('');

const topTags = ref<Facet[]>([]);
const topCountries = ref<CountryFacet[]>([]);

/** Reachability per station id (directory) or url (imports). */
const statuses = ref<Record<string, StationStatus>>({});
const checkingCount = ref(0);

/** Starred stations, rendered as the pinned first section. */
const favorites = ref<RadioSong[]>([]);
const favoriteIds = computed(() => new Set(favorites.value.map((s) => s.id)));

/** Collapse preferences, persisted so the page opens the way it was left.
 *  Sections with no content default to collapsed; see radioSections.ts. */
const COLLAPSE_KEY = 'radio-collapsed-sections';
const collapsePrefs = ref(decodeCollapsePrefs(readCollapse()));

function readCollapse(): string | null {
  try {
    return localStorage.getItem(COLLAPSE_KEY);
  } catch {
    // Private mode: collapsing works for the session but does not persist.
    return null;
  }
}

function collapsed(key: string, empty = false): boolean {
  return isCollapsed(collapsePrefs.value, key, empty);
}

function toggleSection(key: string, empty = false): void {
  // A new Map so the ref is replaced and every v-show re-evaluates.
  collapsePrefs.value = toggleCollapse(collapsePrefs.value, key, empty);
  try {
    localStorage.setItem(COLLAPSE_KEY, encodeCollapsePrefs(collapsePrefs.value));
  } catch {
    /* private mode: the choice simply does not persist */
  }
}

// ─── Station status ───────────────────────────────────────────────────────

/** Status is looked up by id for directory rows and by stream URL for imports,
 *  matching what the batch endpoint accepts. */
function statusKey(s: Song): string {
  return s.id;
}

function statusOf(s: Song): StationStatus {
  return statuses.value[statusKey(s)] ?? {
    id: s.id,
    url: '',
    online: false,
    state: 'unknown',
    httpStatus: null,
    latencyMs: null,
    checkedAt: '',
    fromDirectory: false,
  };
}

function statusClass(s: Song): Record<string, boolean> {
  const state = statusOf(s).state;
  return { 'is-offline': state === 'offline', 'is-unknown': state === 'unknown' };
}

function statusTitle(s: Song): string {
  const st = statusOf(s);
  if (st.state === 'online') return `在线${st.latencyMs != null ? ` · ${st.latencyMs} ms` : ''}`;
  if (st.state === 'offline') return st.httpStatus ? `离线 · HTTP ${st.httpStatus}` : '离线 · 无响应';
  return '在线状态未知（检测超时或站点无响应）';
}

/** The short form shown in the card footer; `statusTitle` is the hover detail.
 *  Kept compact on purpose: an import card has four action buttons in the same
 *  row, and "离线 · HTTP 404" would push the row past the card's width. */
function statusLabel(s: Song): string {
  const st = statusOf(s);
  if (st.state === 'online') return st.latencyMs != null ? `在线 · ${st.latencyMs} ms` : '在线';
  if (st.state === 'offline') return '离线';
  return '状态未知';
}

/**
 * Second/third line of a card. Directory rows get what the catalogue knows
 * (country/language, codec, bitrate); an import has none of that, so its note
 * from the playlist — region or FM frequency — is the useful descriptor.
 *
 * An import keeps `group,note` in `tags`; the group is stripped here because
 * "我的电台" already groups by it and the card would otherwise say it twice.
 */
function localNote(s: RadioSong): string {
  const group = s.group ?? '';
  const album = s.album ?? '';
  if (!album || album === group) return '';
  if (group && album.startsWith(`${group},`)) return album.slice(group.length + 1).trim();
  return album;
}

function stationMeta(s: Song): string {
  const song = s as RadioSong;
  if (song.local) return localNote(song) || '本地电台';
  return [song.artist, song.codec, song.bitrate ? `${song.bitrate} kbps` : '']
    .filter(Boolean)
    .join(' · ') || '网络电台';
}

function stationTags(s: Song): string {
  const song = s as RadioSong;
  if (song.local) return song.group || '本地导入';
  const tags = (song.album ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return tags.join(' · ') || '网络电台';
}

/** How many stations one status request asks about. The endpoint caps at 60. */
const STATUS_BATCH = 40;

/** Every row the page can check, pinned and curated first: a full directory
 *  page can use the whole batch, and a favorite stuck on "unknown" is exactly
 *  the card whose reachability the user wants to know. */
function defaultStatusIds(): string[] {
  return [...new Set([
    ...favorites.value.map((s) => s.id),
    ...localStations.value.map((s) => s.id),
    ...stations.value.map((s) => s.id),
  ])];
}

/** What the current filter actually renders — the same rows the page is
 *  showing. A local-group filter hides the directory section, so its stations
 *  are not part of "the current view" then. */
function visibleStatusIds(): string[] {
  return [...new Set([
    ...favorites.value.map((s) => s.id),
    ...filteredLocalStations.value.map((s) => s.id),
    ...(isLocalGroupTag.value ? [] : stations.value.map((s) => s.id)),
  ])];
}

/**
 * Probe `ids` and merge the answers into `statuses`.
 *
 * Batched by STATUS_BATCH because the endpoint caps a request at 60 and a
 * "check everything" click can cover the imports plus a full directory page.
 * `force` sets `refresh=1`, which skips the server's 60s per-URL cache.
 */
async function runStatusCheck(ids: string[], force: boolean): Promise<number> {
  if (ids.length === 0) return 0;
  let updated = 0;
  checkingCount.value = ids.length;
  try {
    for (let offset = 0; offset < ids.length; offset += STATUS_BATCH) {
      const batch = ids.slice(offset, offset + STATUS_BATCH);
      const params = new URLSearchParams();
      for (const id of batch) params.append('id', id);
      if (force) params.set('refresh', '1');

      const res = await axios.get('/api/radio/status', { params });
      const rows: StationStatus[] = res.data?.statuses ?? [];
      const next = { ...statuses.value };
      for (const row of rows) next[row.id] = row;
      statuses.value = next;
      updated += rows.length;
      checkingCount.value = Math.max(0, ids.length - (offset + batch.length));
    }
  } catch {
    // A failed check must not make every station look dead: leave the previous
    // (or unknown) answers in place and let the next load retry.
  } finally {
    checkingCount.value = 0;
  }
  return updated;
}

/**
 * Automatic pass after a list loads: one batch, no cache bypass. The server
 * caches per URL for a minute and limits its own concurrency, so repeating
 * this on every mount is cheap.
 */
async function checkStatuses(): Promise<void> {
  await runStatusCheck(defaultStatusIds().slice(0, STATUS_BATCH), false);
}

/** The "检测在线" button: re-probe everything the current filter renders,
 *  ignoring the cache so the click has a visible effect. */
async function recheckVisible(): Promise<void> {
  const ids = visibleStatusIds();
  if (ids.length === 0) {
    store.notify('当前没有可检测的电台', 'info');
    return;
  }
  const updated = await runStatusCheck(ids, true);
  store.notify(
    updated > 0 ? `已更新 ${updated} 个电台的在线状态` : '在线状态更新失败',
    updated > 0 ? 'info' : 'error',
  );
}

const nowPlaying = ref<NowPlaying | null>(null);
const nowPlayingLoading = ref(false);

// ─── Local imports ────────────────────────────────────────────────────────
const showImport = ref(false);
const importText = ref('');
const importUrl = ref('');
const importName = ref('');
const importGroup = ref('');
const importCover = ref('');
const importing = ref(false);
const importMessage = ref('');
const importError = ref(false);
const importSkipped = ref<Array<{ line: number; reason: string; raw: string }>>([]);
// Picking a file only fills the textarea — the import itself stays one request
// with one plain-text field, so the server needs no multipart handling.
const importFileName = ref('');
const importFileStats = ref('');

/** Max playlist size. The server caps an import at 500 stations and the global
 *  JSON body limit is 400kb; refusing an oversized file here gives a clear
 *  message instead of an opaque 413 after reading it. */
const MAX_PLAYLIST_BYTES = 400 * 1024;

async function onPickFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // Reset so picking the same file twice still fires change.
  input.value = '';
  if (!file) return;

  importMessage.value = '';
  importError.value = false;
  importSkipped.value = [];

  if (file.size > MAX_PLAYLIST_BYTES) {
    importError.value = true;
    importMessage.value = `文件过大（${Math.round(file.size / 1024)} KB），上限 400 KB`;
    return;
  }
  try {
    const text = await file.text();
    importText.value = text;
    importFileName.value = file.name;
    // A local count is only a heads-up; the server's parse is authoritative and
    // reports skipped entries with line numbers after 预览 / 导入.
    const urls = text.split(/\r?\n/).filter((l) => /^https?:\/\//i.test(l.trim())).length;
    importFileStats.value = urls > 0 ? `已载入 ${urls} 个地址` : '未找到 http(s) 地址';
    if (urls === 0) {
      importError.value = true;
      importMessage.value = '文件里没有找到 http(s) 流地址';
    }
  } catch {
    importError.value = true;
    importMessage.value = '读取文件失败';
  }
}

function clearPickedFile(): void {
  importFileName.value = '';
  importFileStats.value = '';
  importText.value = '';
  importMessage.value = '';
  importError.value = false;
  importSkipped.value = [];
}

export interface LocalSong extends RadioSong {
  group?: string;
  local?: boolean;
}
const localStations = ref<LocalSong[]>([]);
const localGroups = ref<Array<{ name: string; count: number }>>([]);

/** The station currently on air, if the active bot is playing radio. */
const liveStation = computed<Song | null>(() => {
  const song = store.activeBot?.currentSong as Song | null | undefined;
  if (!song || song.platform !== 'radio') return null;
  return song;
});

let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Skip a redundant round trip only while the last answer is still inside the
 *  server's own 15s cache window; anything older is what the poll exists for. */
const NOW_PLAYING_STALE_MS = 15_000;

async function loadStations() {
  // A "my group" selection is answered entirely from the local store — the
  // directory has no such tag, so querying it would only ever return zero.
  if (isLocalGroupTag.value) {
    stations.value = [];
    error.value = '';
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const params: Record<string, string | number> = {
      limit: 48,
      order: query.value ? 'votes' : 'clickcount',
    };
    if (query.value.trim()) params.q = query.value.trim();
    if (country.value) params.country = country.value;
    if (tag.value) params.tags = tag.value;
    if (bitrateMin.value > 0) params.bitrateMin = bitrateMin.value;
    const res = await axios.get('/api/radio/stations', { params });
    stations.value = res.data?.stations ?? [];
    // Online check runs after the list is painted so a slow station never
    // delays the page; cards start neutral and get their dot when it answers.
    checkStatuses();
  } catch (e) {
    const err = e as { response?: { data?: { error?: string } }; message?: string };
    error.value = err.response?.data?.error ?? err.message ?? '加载电台失败';
    stations.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadFacets() {
  try {
    const res = await axios.get('/api/radio/facets');
    topTags.value = (res.data?.tags ?? []).slice(0, 40);
    topCountries.value = (res.data?.countries ?? []).slice(0, 40);
  } catch {
    // Facets are a convenience; the page works without them.
  }
}

function clearQuery() {
  query.value = '';
  loadStations();
}

async function playStation(s: Song) {
  await store.playSong({ ...s, live: true });
}

async function addStation(s: Song) {
  await store.addSong({ ...s, live: true });
}

// ─── Local station management ─────────────────────────────────────────────

function localByGroup(group: string): LocalSong[] {
  return filteredLocalStations.value.filter((s) => (s.group ?? DEFAULT_LOCAL_GROUP) === group);
}

/** True when `tag` names one of the operator's own groups. Those never exist
 *  in the directory, so the value doubles as both a local filter and a signal
 *  to skip the directory query. */
const isLocalGroupTag = computed(() => isLocalGroupTagValue(tag.value, localGroups.value));

/** Imported stations matching the current filter. See `radioFilter.ts` for the
 *  rules — the same select drives the directory and the imports, and each side
 *  filters itself because their vocabularies do not overlap. */
const filteredLocalStations = computed<LocalSong[]>(() =>
  filterLocalStations(localStations.value, {
    tag: tag.value,
    country: country.value,
    bitrateMin: bitrateMin.value,
  }, localGroups.value),
);

/** Group headers, re-counted after filtering so a header never claims more
 *  stations than are shown under it. */
const visibleLocalGroups = computed(() =>
  groupCounts(filteredLocalStations.value, localGroups.value),
);

const localFilterActive = computed(
  () => !!tag.value && filteredLocalStations.value.length !== localStations.value.length,
);

/** Why the import grid is empty, phrased for the filter that caused it. Country
 *  and bitrate describe directory records; imports have neither, so saying
 *  "no match" there would imply the filter was evaluated against the imports. */
const localExclusionReason = computed(() => {
  if (country.value) return `本地电台没有国家信息，无法按「${country.value}」筛选`;
  if (bitrateMin.value > 0) return `本地电台没有码率信息，无法按 ≥${bitrateMin.value} kbps 筛选`;
  return `没有符合「${tag.value}」的本地电台`;
});

function clearLocalFilter(): void {
  tag.value = '';
  loadStations();
}

async function loadLocal() {
  try {
    const res = await axios.get('/api/radio/local');
    localStations.value = res.data?.stations ?? [];
    localGroups.value = res.data?.groups ?? [];
    // Imports are checked by stream URL; the server skips anything not playable.
    checkStatuses();
  } catch {
    // The panel is optional; a disabled radio provider just leaves it empty.
    localStations.value = [];
    localGroups.value = [];
  }
}

// ─── Favorites ────────────────────────────────────────────────────────────

/**
 * The pinned list. It comes from the same station file as 我的电台 (that is what
 * lets a starred directory station stay pinned while the directory is down),
 * but it is its own endpoint: the local store also holds the imports, and only
 * rows carrying the star belong up here.
 */
async function loadFavorites(): Promise<void> {
  try {
    const res = await axios.get('/api/radio/favorites');
    favorites.value = res.data?.favorites ?? [];
    if (favorites.value.length) checkStatuses();
  } catch {
    favorites.value = [];
  }
}

function isFavorite(s: Song): boolean {
  return favoriteIds.value.has(s.id) || favorites.value.some((f) => f.id === s.id);
}

async function toggleFavorite(s: Song): Promise<void> {
  const next = !isFavorite(s);
  try {
    const res = await axios.post('/api/radio/favorites', {
      station: { ...s, live: true },
      favorite: next,
    });
    favorites.value = res.data?.favorites ?? [];
    // An import also carries the flag, so its card's star follows along.
    await loadLocal();
    store.notify(next ? '已收藏，已置顶' : '已取消收藏', 'info');
  } catch (e) {
    const err = e as { response?: { data?: { error?: string } } };
    store.notify(err.response?.data?.error ?? '收藏失败', 'error');
  }
}

async function doImport(dryRun: boolean) {
  importMessage.value = '';
  importError.value = false;
  importSkipped.value = [];
  if (!importText.value.trim() && !importUrl.value.trim()) {
    importError.value = true;
    importMessage.value = '请粘贴播放列表内容、选择文件，或填写一个流地址';
    return;
  }
  importing.value = true;
  try {
    const res = await axios.post('/api/radio/local/import', {
      playlist: importText.value,
      url: importUrl.value.trim() || undefined,
      name: importName.value.trim() || undefined,
      group: importGroup.value.trim() || undefined,
      cover: importCover.value.trim() || undefined,
      dryRun,
    });
    importSkipped.value = res.data?.skipped ?? [];
    if (dryRun) {
      importMessage.value = `预览：将导入 ${res.data?.wouldImport ?? 0} 个电台`;
    } else {
      const { added = 0, updated = 0, total = 0 } = res.data ?? {};
      importMessage.value = `已导入：新增 ${added}，更新 ${updated}，当前共 ${total} 个本地电台`;
      importText.value = '';
      importUrl.value = '';
      importName.value = '';
      importCover.value = '';
      // The file was consumed by this import; keep the stale name/stats from
      // implying a second one is still staged.
      importFileName.value = '';
      importFileStats.value = '';
      await loadLocal();
    }
  } catch (e) {
    const err = e as { response?: { data?: { error?: string; skipped?: typeof importSkipped.value } } };
    importError.value = true;
    importMessage.value = err.response?.data?.error ?? '导入失败';
    importSkipped.value = err.response?.data?.skipped ?? [];
  } finally {
    importing.value = false;
  }
}

async function removeLocal(s: LocalSong) {
  try {
    await axios.delete(`/api/radio/local/${encodeURIComponent(s.id)}`);
    await loadLocal();
  } catch {
    importError.value = true;
    importMessage.value = '移除失败';
  }
}

// ─── Cover art ────────────────────────────────────────────────────────────
//
// Most playlists carry no tvg-logo, so imported stations fall back to the
// gradient placeholder. The operator can paste an image URL per station; the
// value lives alongside the station on disk and survives a re-import.

const coverEditorId = ref<string | null>(null);
const coverDraft = ref('');
const coverSaving = ref(false);
const coverError = ref('');

const coverStation = computed(() => {
  const id = coverEditorId.value;
  return id ? localStations.value.find((s) => s.id === id) ?? null : null;
});

function openCoverEditor(s: LocalSong): void {
  coverEditorId.value = s.id;
  coverDraft.value = s.coverUrl ?? '';
  coverError.value = '';
}

function closeCoverEditor(): void {
  coverEditorId.value = null;
  coverDraft.value = '';
  coverError.value = '';
}

async function saveCover(): Promise<void> {
  const id = coverEditorId.value;
  if (!id) return;
  const cover = coverDraft.value.trim();
  if (cover && !/^https?:\/\//i.test(cover)) {
    coverError.value = '请填写 http(s) 开头的图片地址';
    return;
  }
  coverSaving.value = true;
  coverError.value = '';
  try {
    await axios.put(`/api/radio/local/${encodeURIComponent(id)}/cover`, { cover });
    await loadLocal();
    closeCoverEditor();
  } catch (e) {
    const err = e as { response?: { data?: { error?: string } } };
    coverError.value = err.response?.data?.error ?? '保存失败';
  } finally {
    coverSaving.value = false;
  }
}

async function loadNowPlaying() {
  const station = liveStation.value;
  if (!station) {
    nowPlaying.value = null;
    return;
  }
  // The point of the poll is to pick up the station's next track, so the cache
  // key must include the fetch time — keying on the station id alone made every
  // poll after the first return early and froze the title at whatever was
  // playing when the page opened.
  const fetchedAt = nowPlaying.value?.fetchedAt ? Date.parse(nowPlaying.value.fetchedAt) : 0;
  const fresh = nowPlaying.value?.stationId === station.id && Date.now() - fetchedAt < NOW_PLAYING_STALE_MS;
  if (fresh && !nowPlayingLoading.value) return;
  nowPlayingLoading.value = true;
  try {
    const res = await axios.get('/api/radio/now-playing', { params: { id: station.id } });
    nowPlaying.value = res.data ?? null;
  } catch {
    nowPlaying.value = null;
  } finally {
    nowPlayingLoading.value = false;
  }
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (!liveStation.value) return;
  loadNowPlaying();
  // 20s: the server caches for 15s, so this never stampedes the station.
  pollTimer = setInterval(loadNowPlaying, 20_000);
}

watch(liveStation, (_next, prev) => {
  if (prev?.id !== _next?.id) nowPlaying.value = null;
  restartPolling();
});

function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

onMounted(() => {
  loadStations();
  loadFacets();
  loadLocal();
  loadFavorites();
  restartPolling();
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style lang="scss" scoped>
.radio-page {
  padding-bottom: 40px;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  margin-bottom: 16px;
  transition: background var(--transition-fast);

  &:focus-within { background: var(--hover-bg); }
}

.search-icon {
  font-size: 20px;
  opacity: 0.4;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-size: var(--fs-base);
  font-family: inherit;

  &::placeholder { color: var(--text-secondary); opacity: 0.7; }
  &::-webkit-search-cancel-button { display: none; }
}

.search-clear {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
  &:hover { background: var(--hover-bg); color: var(--text-primary); }
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 28px;
}

.filter-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--fs-xs);
  color: var(--text-secondary);

  select {
    min-width: 130px;
    padding: 7px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-color);
    background: var(--bg-card);
    color: var(--text-primary);
    font-size: var(--fs-sm);
    font-family: inherit;
    cursor: pointer;
  }
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast);

  &:hover:not(:disabled) { color: var(--text-primary); border-color: var(--color-primary); }
  &:disabled { opacity: 0.5; cursor: default; }
}

.spinning { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.live-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--color-primary);
  color: var(--color-on-primary);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  vertical-align: middle;
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse { 50% { opacity: 0.3; } }

.now-playing {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
}

.now-playing-info { flex: 1; min-width: 0; }

.now-playing-name {
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-playing-artist {
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-playing-meta {
  margin-top: 6px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  opacity: 0.85;
}

.meta-sep { opacity: 0.5; }

.now-playing-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.count-badge {
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--hover-bg);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  font-weight: var(--fw-regular);
  vertical-align: middle;
}

// ─── Collapsible section headings ─────────────────────────────────────────
// The title is the toggle. A section with nothing in it starts collapsed (the
// default lives in radioSections.ts); the heading itself stays visible so the
// section can still be opened and the page does not reflow when the first item
// arrives.
.section-title {
  font-size: 22px;
  font-weight: var(--fw-bold, 700);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-title-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  border-radius: var(--radius-sm);
  transition: color var(--transition-fast);

  &:hover { color: var(--text-primary); }
}

.section-chevron {
  font-size: 18px;
  opacity: 0.6;
  transition: transform var(--transition-fast);

  &.open { transform: rotate(90deg); }
}

.section-title-icon {
  font-size: 16px;
  color: var(--brand-radio);
}

.local-group-toggle {
  cursor: pointer;
  user-select: none;

  &:hover { color: var(--text-primary); }
}

.checking-hint {
  margin-left: 10px;
  font-size: var(--fs-xs);
  font-weight: var(--fw-regular);
  color: var(--text-tertiary);
}

// ─── Reachability ─────────────────────────────────────────────────────────
// Colour is never the only signal: the card footer spells the state out,
// offline cards also dim, and the text carries a title so hover explains the
// detail. `unknown` stays neutral rather than borrowing the offline red — a
// slow probe is not evidence of a dead station.
.station-card.is-offline {
  opacity: 0.7;
}

.station-fav {
  &.is-on { opacity: 1; color: var(--color-paused); }
}

.station-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

// Cover on the left, text beside it, actions on a footer row inside the text
// column. Keeping the buttons out of the horizontal flow is what gives the
// name/meta/tags their width back: with four 30px buttons inline, an import
// card left roughly 50px for text.
.station-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  cursor: pointer;
  border: 1px solid transparent;
  transition: border-color var(--transition-fast), background var(--transition-fast);

  &:hover { background: var(--hover-bg); }
  &.active { border-color: var(--color-primary); }
}

.station-cover {
  position: relative;
  flex-shrink: 0;
  display: grid;
  place-items: center;

  .play-overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.5);
    color: #fff;
    font-size: 26px;
    opacity: 0;
    transition: opacity var(--transition-fast);
  }

  .station-card:hover & .play-overlay { opacity: 1; }
}

.station-body {
  flex: 1;
  min-width: 0;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.station-name {
  font-size: var(--fs-body);
  font-weight: var(--fw-medium);
  line-height: 1.45;
  // Station names are long ("上海经典947音乐广播 FM94.7 · 上海"); two lines read
  // far better than one ellipsised line.
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.station-meta,
.station-tags {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.station-tags {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.station-footer {
  margin-top: auto;
  padding-top: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
}

.station-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-2xs);
  color: var(--text-tertiary);
  white-space: nowrap;

  &.online { color: var(--color-online); }
  &.offline { color: var(--color-paused); }
  &.unknown { opacity: 0.7; }

  .state-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }
}

.station-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.station-add {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-fast), background var(--transition-fast);

  .station-card:hover &,
  &:focus-visible { opacity: 1; }
  &:hover { background: var(--hover-bg); color: var(--text-primary); }
}

// Touch screens never hover, so a hover-revealed ★ would be unfindable there.
// Keep the actions visible whenever hover is not a thing.
@media (hover: none) {
  .station-add { opacity: 0.85; }
}

.skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.skeleton-card {
  height: 132px;
  border-radius: var(--radius-md);
  background: var(--bg-card);
  animation: shimmer 1.4s ease-in-out infinite;
}
@keyframes shimmer { 50% { opacity: 0.5; } }

.error-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-radius: var(--radius-md);
  background: var(--bg-card);
  color: var(--color-error, #e5484d);
  font-size: var(--fs-sm);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 56px 0;
  color: var(--text-secondary);
  font-size: var(--fs-sm);
}

.empty-icon { font-size: 40px; opacity: 0.4; }

// The hint shown by an empty 收藏 / 我的电台 section once it is opened. Quieter
// than .empty-state (no 56px padding) because the section is still one line of
// page furniture, not a full page of nothing.
.section-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-radius: var(--radius-md);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: var(--fs-sm);

  .empty-icon { font-size: 20px; opacity: 0.5; flex-shrink: 0; }
}

// ─── Import panel ─────────────────────────────────────────────────────────

.import-panel {
  padding: 16px;
  margin-bottom: 28px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
}

.import-hint {
  margin: 0 0 12px;
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-secondary);

  code {
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--hover-bg);
    font-size: 0.95em;
  }
}

.import-file {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

// The real <input type=file> is hidden and driven by the label, so the picker
// looks like the other buttons instead of the browser's default control.
.import-file-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  border: 1px dashed var(--border-color);

  &:hover { background: var(--hover-bg); }
}

.import-file-input {
  display: none;
}

.import-file-stats {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.import-textarea,
.import-input {
  width: 100%;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
  background: var(--bg-primary, rgba(0, 0, 0, 0.02));
  color: var(--text-primary);
  font-size: var(--fs-sm);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  line-height: 1.6;
  outline: none;
  resize: vertical;

  &:focus { border-color: var(--color-primary); }
  &::placeholder { color: var(--text-secondary); opacity: 0.7; }
}

.import-single {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  gap: 8px;
  margin-top: 8px;

  .import-input { font-family: inherit; }
}

.import-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.import-message {
  margin-top: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: var(--hover-bg);
  font-size: var(--fs-xs);
  color: var(--text-secondary);

  &.is-error {
    color: var(--color-error, #e5484d);
    background: color-mix(in srgb, var(--color-error, #e5484d) 10%, transparent);
  }
}

.import-skipped {
  margin-top: 8px;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.import-skipped-title { margin-bottom: 4px; opacity: 0.85; }

.import-skipped-row {
  padding-left: 8px;
  line-height: 1.7;
  opacity: 0.75;
}

// ─── Local groups ─────────────────────────────────────────────────────────

.local-group { margin-bottom: 20px; }

.local-group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
}

.local-group-count {
  padding: 0 7px;
  border-radius: 999px;
  background: var(--hover-bg);
  font-size: var(--fs-xs);
  font-weight: var(--fw-regular);
}

.local-chip {
  margin-right: 6px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--hover-bg);
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: var(--fw-regular);
  vertical-align: 1px;
}

.station-remove {
  &:hover { color: var(--color-error, #e5484d) !important; }
}

.local-filter-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: 10px;
  font-size: var(--fs-xs);
  font-weight: var(--fw-regular);
  color: var(--text-secondary);
  vertical-align: middle;
}

.local-filter-clear {
  padding: 0;
  color: var(--color-primary);
  font-size: var(--fs-xs);
  text-decoration: underline;

  &:hover { opacity: 0.8; }
}

// The section still renders when a filter matches nothing, so the hint and the
// "no match" message stay visible instead of the whole block vanishing.
.local-empty { margin-bottom: 20px; }

.cover-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.55);
}

.cover-dialog {
  width: min(460px, 100%);
  padding: 18px;
  border-radius: var(--radius-lg, 14px);
  // Opaque on purpose: --bg-card is translucent and the dialog sits over the
  // page, so a translucent surface would let station cards show through.
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45);
}

.cover-dialog-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold, 600);
  color: var(--text-primary);
}

.cover-dialog-body {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.cover-dialog-fields {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cover-dialog-name {
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold, 600);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cover-dialog-input { font-family: inherit; }

.cover-dialog-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 768px) {
  .filter-field select { min-width: 100px; }
  .station-grid,
  .skeleton-grid { grid-template-columns: 1fr; }
  .now-playing { flex-wrap: wrap; }
  .now-playing-actions { width: 100%; justify-content: flex-end; }
  .cover-dialog-body { flex-direction: column; align-items: center; }
  .cover-dialog-fields { width: 100%; }
}
</style>
