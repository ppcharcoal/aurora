<script lang="ts">
  import { covers } from "../covers.svelte";
  import { isAndroid } from "../platform";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { library } from "../sources/local.svelte";
  import { player } from "../player.svelte";
  import { profiles } from "../profiles.svelte";
  import { dayKey, stats } from "../stats.svelte";
  import { ui } from "../ui.svelte";
  import Artwork from "../components/Artwork.svelte";
  import Icon from "../components/Icon.svelte";
  import type { Track } from "../types";
  import { lastfm } from "../lastfm.svelte";
  import LastfmSettings from "../components/LastfmSettings.svelte";

  const me = $derived(profiles.active);
  const v = $derived(stats.value);

  /** "12 h 5 min", "41 min", "35 s" */
  function dur(ms: number) {
    const min = Math.floor(ms / 60000);
    if (min < 1) return `${Math.floor(ms / 1000)} s`;
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  }

  /* ---- last 14 days ---- */
  const days = $derived.by(() => {
    v; // recompute as listening time grows
    const out: { key: string; label: string; short: string; ms: number; today: boolean }[] = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = dayKey(d);
      out.push({
        key,
        label: d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
        short: d.toLocaleDateString(undefined, { weekday: "narrow" }),
        ms: v.days[key] ?? 0,
        today: i === 0,
      });
    }
    return out;
  });
  const maxDay = $derived(Math.max(60_000, ...days.map((d) => d.ms)));
  const week = $derived(days.slice(7).reduce((s, d) => s + d.ms, 0));
  const today = $derived(days[13].ms);
  const daysListened = $derived(Object.values(v.days).filter((ms) => ms > 0).length);
  let hover = $state<number | null>(null);

  /* ---- top songs / artists ---- */
  const topSongs = $derived.by(() => {
    // Copies of the same song count together (they resolve to the same track).
    const byTrack = new Map<Track, { t: Track; ms: number; plays: number }>();
    for (const [id, ms] of Object.entries(v.tracks)) {
      const t = library.byId.get(id);
      if (!t) continue;
      const e = byTrack.get(t) ?? { t, ms: 0, plays: 0 };
      e.ms += ms;
      e.plays += v.plays[id] ?? 0;
      byTrack.set(t, e);
    }
    return [...byTrack.values()].sort((a, b) => b.ms - a.ms).slice(0, 8);
  });
  const topArtists = $derived(
    Object.entries(v.artists)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6),
  );
  const artistMax = $derived(topArtists[0]?.[1] ?? 1);

  async function rename() {
    if (!me) return;
    const name = await ui.prompt("Rename profile", "Your name", me.name);
    if (name) profiles.rename(me.id, name);
  }

  async function newProfile() {
    const name = await ui.prompt("New profile", "Name", "");
    if (!name) return;
    const id = await profiles.create(name);
    profiles.switchTo(id);
  }

  async function del(id: string, name: string) {
    const yes = await ask(`Delete the profile “${name}”? Its playlists, history and listening time are removed. Your music files stay.`, {
      title: "Delete profile",
      kind: "warning",
      okLabel: "Delete",
    });
    if (yes) profiles.remove(id);
  }

  function avatarMenu(e: MouseEvent) {
    if (!me) return;
    const id = me.id;
    ui.openMenu(e, [
      { label: "Choose picture…", icon: "reveal", action: () => profiles.chooseAvatar(id) },
      ...(me.avatar ? [{ label: "Remove picture", icon: "x" as const, action: () => profiles.removeAvatar(id) }] : []),
    ]);
  }

  const initial = (n: string) => n.trim().charAt(0).toUpperCase() || "?";
</script>

{#if me}
  <div class="page">
    <header class="hero">
      <button class="avatar" onclick={() => profiles.chooseAvatar(me.id)} oncontextmenu={avatarMenu} title="Choose a profile picture">
        {#if me.avatar}
          <img src={profiles.avatarSrc(me)} alt="" />
        {:else}
          <span class="init">{initial(me.name)}</span>
        {/if}
        <span class="overlay"><Icon name="edit" size={22} /></span>
      </button>
      <div class="who">
        <div class="kind">Profile</div>
        <button class="name" onclick={rename} title="Rename"><h1>{me.name}</h1></button>
        <p class="muted">Listening since {new Date(v.since).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</p>
      </div>
    </header>

    {#if ui.phone}
      <nav class="quick">
        <button class="btn" onclick={() => ui.go({ name: "loved" })}><Icon name="heart" size={16} /> Loved</button>
        <button class="btn" onclick={() => ui.go({ name: "friends" })}><Icon name="users" size={16} /> Friends</button>
        <button class="btn" onclick={() => ui.go({ name: "settings" })}><Icon name="settings" size={16} /> Settings</button>
      </nav>
    {/if}

    <section class="total">
      <div class="big">{dur(v.totalMs)}</div>
      <div class="lbl">listened in total</div>
      <dl class="mini">
        <div><dt>Today</dt><dd>{dur(today)}</dd></div>
        <div><dt>Last 7 days</dt><dd>{dur(week)}</dd></div>
        <div><dt>Days with music</dt><dd>{daysListened}</dd></div>
        <div><dt>Songs played</dt><dd>{Object.values(v.plays).reduce((s, n) => s + n, 0)}</dd></div>
      </dl>
    </section>

    <section>
      <h2 class="section-title">Listening time, last 14 days</h2>
      <div class="chart" role="img" aria-label={`Listening time per day: ${days.map((d) => `${d.label} ${dur(d.ms)}`).join("; ")}`}>
        <div class="bars" onpointerleave={() => (hover = null)} role="presentation">
          {#each days as d, i (d.key)}
            <div class="col" role="presentation" onpointerenter={() => (hover = i)}>
              <div class="bar" class:today={d.today} class:zero={!d.ms} style:height={`${Math.max(d.ms ? 3 : 0, (d.ms / maxDay) * 100)}%`}></div>
            </div>
          {/each}
          {#if hover !== null}
            <div class="tip" style:left={`${((hover + 0.5) / days.length) * 100}%`}>
              <strong>{dur(days[hover].ms)}</strong>
              <span>{days[hover].label}</span>
            </div>
          {/if}
        </div>
        <div class="axis">
          {#each days as d (d.key)}<span class:today={d.today}>{d.today ? "Today" : d.short}</span>{/each}
        </div>
      </div>
    </section>

    <div class="twocol">
      <section>
        <h2 class="section-title">Most played songs</h2>
        {#if topSongs.length}
          <ol class="top">
            {#each topSongs as s, i (s.t.id)}
              <li>
                <button class="hit" onclick={() => player.playList(topSongs.map((x) => x.t), i)} aria-label={`Play ${s.t.title}`}></button>
                <span class="rank">{i + 1}</span>
                <Artwork src={s.t.art ?? covers.get(s.t.artist, s.t.title)} size={40} radius="6px" />
                <span class="txt"><span class="tt">{s.t.title}</span><span class="ta">{s.t.artist}</span></span>
                <span class="val">{dur(s.ms)}</span>
              </li>
            {/each}
          </ol>
        {:else}
          <p class="muted">Play some music and your favourites show up here.</p>
        {/if}
      </section>
      <section>
        <h2 class="section-title">Top artists</h2>
        {#if topArtists.length}
          <ol class="artists">
            {#each topArtists as [name, ms] (name)}
              <li>
                <div class="row"><span class="tt">{name}</span><span class="val">{dur(ms)}</span></div>
                <div class="meter"><div style:transform={`scaleX(${ms / artistMax})`}></div></div>
              </li>
            {/each}
          </ol>
        {:else}
          <p class="muted">Nothing yet.</p>
        {/if}
      </section>
    </div>

    {#if lastfm.history}
      {@const h = lastfm.history}
      <section>
        <h2 class="section-title">All time on Last.fm</h2>
        <div class="twocol">
          <ol class="top">
            {#each h.tracks.slice(0, 8) as it, i (it.artist + it.title)}
              {@const mine = lastfm.find(it.artist, it.title)}
              <li>
                {#if mine}<button class="hit" onclick={() => player.playList([mine], 0)} aria-label={`Play ${it.title}`}></button>{/if}
                <span class="rank">{i + 1}</span>
                <Artwork src={mine?.art ?? covers.get(it.artist, it.title)} size={40} radius="6px" />
                <span class="txt"><span class="tt">{it.title}</span><span class="ta">{it.artist}{mine ? "" : " — not downloaded"}</span></span>
                <span class="val">{it.plays.toLocaleString()} plays</span>
              </li>
            {/each}
          </ol>
          <ol class="artists">
            {#each h.artists.slice(0, 6) as a (a.name)}
              <li>
                <div class="row"><span class="tt">{a.name}</span><span class="val">{a.plays.toLocaleString()} plays</span></div>
                <div class="meter"><div style:transform={`scaleX(${a.plays / (h.artists[0]?.plays || 1)})`}></div></div>
              </li>
            {/each}
          </ol>
        </div>
      </section>
    {/if}

    <section class="lfmwrap">
      <h2 class="section-title">Connections</h2>
      <LastfmSettings />
    </section>

    <section>
      <h2 class="section-title">Profiles on this {isAndroid ? "phone" : "PC"}</h2>
      <p class="muted note">Each profile has its own playlists, history, settings and listening time. The music library is shared.</p>
      <div class="plist">
        {#each profiles.list as p (p.id)}
          <div class="pcard" class:on={p.id === me.id}>
            <span class="pav">
              {#if p.avatar}<img src={profiles.avatarSrc(p)} alt="" />{:else}{initial(p.name)}{/if}
            </span>
            <span class="pn">{p.name}</span>
            {#if p.id === me.id}
              <span class="cur">Current</span>
            {:else}
              <button class="btn small" onclick={() => profiles.switchTo(p.id)}>Switch</button>
              <button class="icon" onclick={() => del(p.id, p.name)} aria-label={`Delete ${p.name}`} title="Delete profile"><Icon name="trash" size={15} /></button>
            {/if}
          </div>
        {/each}
        <button class="pcard add" onclick={newProfile}><Icon name="plus" size={18} /> New profile</button>
      </div>
    </section>
  </div>
{/if}

<style>
  .quick {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin: -6px 0 20px;
  }
  .hero {
    display: flex;
    align-items: center;
    gap: 28px;
    margin-bottom: 28px;
  }
  .avatar {
    position: relative;
    width: 168px;
    height: 168px;
    flex: none;
    border-radius: 50%;
    overflow: hidden;
    background: linear-gradient(140deg, var(--violet), rgb(var(--accent-rgb)));
    box-shadow: var(--shadow);
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .init {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 72px;
    color: var(--night);
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(15 12 20 / 0.55);
    opacity: 0;
    transition: opacity var(--t-fast);
  }
  .avatar:hover .overlay,
  .avatar:focus-visible .overlay {
    opacity: 1;
  }
  .kind {
    color: var(--ink-2);
    font-size: 13px;
  }
  .name {
    text-align: left;
    max-width: 100%;
  }
  .who {
    min-width: 0;
  }
  h1 {
    overflow-wrap: anywhere;
    font-size: 64px;
    font-variation-settings: "wdth" 78;
    margin: 4px 0 6px;
  }
  .total {
    padding: 24px 26px;
    border-radius: var(--r-panel);
    background: rgb(var(--ink-rgb) / 0.04);
    border: 1px solid var(--line);
  }
  .big {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 56px;
    font-variation-settings: "wdth" 75;
    line-height: 1;
    letter-spacing: -0.02em;
  }
  .lbl {
    color: var(--ink-2);
    margin-top: 6px;
  }
  .mini {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
    margin: 22px 0 0;
    padding-top: 18px;
    border-top: 1px solid var(--line);
  }
  .mini dt {
    font-size: 12px;
    color: var(--ink-3);
  }
  .mini dd {
    margin: 2px 0 0;
    font-size: 18px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  /* ---- chart ---- */
  .chart {
    max-width: 860px;
  }
  .bars {
    position: relative;
    height: 160px;
    display: grid;
    grid-template-columns: repeat(14, 1fr);
    border-bottom: 1px solid rgb(var(--ink-rgb) / 0.16);
  }
  .col {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 0 1px; /* 2px surface gap between bars */
    height: 100%;
  }
  .bar {
    width: min(100%, 34px);
    border-radius: 4px 4px 0 0;
    background: rgb(var(--accent-rgb) / 0.55);
    transition:
      height var(--t-med) var(--ease-out),
      background var(--t-fast);
  }
  .bar.today {
    background: var(--accent);
  }
  .col:hover .bar {
    background: var(--accent);
  }
  .tip {
    position: absolute;
    bottom: calc(100% + 6px);
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    padding: 6px 10px;
    border-radius: 8px;
    white-space: nowrap;
    font-size: 12px;
    color: var(--ink-2);
    background: var(--glass-strong);
    border: 1px solid var(--line);
    pointer-events: none;
  }
  .tip strong {
    color: var(--ink);
    font-size: 14px;
  }
  .axis {
    display: grid;
    grid-template-columns: repeat(14, 1fr);
    margin-top: 6px;
    font-size: 11px;
    color: var(--ink-3);
    text-align: center;
  }
  .axis .today {
    color: var(--ink-2);
    font-weight: 600;
  }
  /* ---- tops ---- */
  .twocol {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 32px;
  }
  .top,
  .artists {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .top li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px;
    border-radius: 10px;
  }
  .top li:hover {
    background: rgb(var(--ink-rgb) / 0.06);
  }
  .hit {
    position: absolute;
    inset: 0;
    border-radius: 10px;
  }
  .rank {
    width: 18px;
    text-align: right;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .tt,
  .ta {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tt {
    font-weight: 600;
  }
  .ta {
    font-size: 13px;
    color: var(--ink-2);
  }
  .val {
    font-size: 13px;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .artists li {
    padding: 8px 0;
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
  }
  .meter {
    height: 6px;
    border-radius: 6px;
    background: rgb(var(--ink-rgb) / 0.08);
    overflow: hidden;
  }
  .meter div {
    height: 100%;
    border-radius: 6px;
    background: rgb(var(--accent-rgb) / 0.75);
    transform-origin: left;
    transition: transform var(--t-med) var(--ease-out);
  }
  .lfmwrap {
    max-width: 900px;
  }
  /* ---- profiles ---- */
  .note {
    margin: -6px 0 14px;
    font-size: 13px;
  }
  .plist {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr));
    gap: 10px;
  }
  .pcard {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 14px;
    background: rgb(var(--ink-rgb) / 0.04);
    border: 1px solid var(--line);
  }
  .pcard.on {
    border-color: rgb(var(--accent-rgb) / 0.45);
  }
  .pcard.add {
    justify-content: center;
    color: var(--ink-2);
    font-weight: 600;
    border-style: dashed;
  }
  .pcard.add:hover {
    color: var(--ink);
  }
  .pav {
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 50%;
    overflow: hidden;
    display: grid;
    place-items: center;
    font-weight: 700;
    color: var(--night);
    background: linear-gradient(140deg, var(--violet), rgb(var(--accent-rgb)));
  }
  .pav img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .pn {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cur {
    font-size: 12px;
    color: var(--accent);
  }
  .btn.small {
    height: 30px;
    padding: 0 12px;
    font-size: 13px;
  }
  .icon {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    color: var(--ink-3);
  }
  .icon:hover {
    color: var(--ink);
    background: rgb(var(--ink-rgb) / 0.08);
  }
  @media (max-width: 1100px) {
    .twocol {
      grid-template-columns: minmax(0, 1fr);
    }
    .mini {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  /* Phone: picture on top, name and buttons centred, nothing wider than the screen. */
  :global(html[data-phone]) .hero {
    flex-direction: column;
    text-align: center;
    gap: 12px;
    margin-bottom: 16px;
  }
  :global(html[data-phone]) .avatar {
    width: 112px;
    height: 112px;
  }
  :global(html[data-phone]) .init {
    font-size: 48px;
  }
  :global(html[data-phone]) .who {
    width: 100%;
  }
  :global(html[data-phone]) .name {
    display: block;
    margin: 0 auto;
    text-align: center;
  }
  :global(html[data-phone]) h1 {
    font-size: 40px;
    line-height: 1.05;
  }
  :global(html[data-phone]) .quick {
    justify-content: center;
    margin: 0 0 16px;
  }
  :global(html[data-phone]) .total {
    padding: 18px;
  }
  :global(html[data-phone]) .big {
    font-size: 42px;
  }
  :global(html[data-phone]) .mini {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  :global(html[data-phone]) .twocol {
    gap: 8px;
  }
  :global(html[data-phone]) .top li {
    gap: 10px;
    padding: 6px 2px;
  }
  :global(html[data-phone]) .val {
    font-size: 12px;
  }
</style>
