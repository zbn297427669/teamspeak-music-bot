/**
 * Known station artwork, keyed by stream URL.
 *
 * Most public Chinese radio playlists ship no `tvg-logo`, and the Radio Browser
 * directory carries no favicon for them either — so importing a bare M3U renders
 * a wall of identical note placeholders. These 44 covers were resolved once:
 *
 *   - 25 from Qingting FM channel ids, which the stream path itself carries
 *     (`lhttp.qingting.fm/live/<id>/…`);
 *   - 15 from directory records whose name matched the station exactly;
 *   -  4 hand-checked by frequency + city (浙江动听968, 广西 FM95.0,
 *     山东经典105, 天津 My FM 100.5).
 *
 * Every URL was then fetched and kept only if it returned a real image
 * (`image/*`, >500 bytes). The remaining 7 of the 51-station list have no
 * reliable source and are deliberately absent — a wrong logo is worse than none.
 *
 * Keyed by URL, not by name: names drift between playlist revisions (a trailing
 * " FM94.7") while the stream address is stable, and a near-miss name match
 * would silently paint one station with another's logo.
 *
 * This is only a *fallback*. A playlist's own `tvg-logo` and any cover the
 * operator set by hand both win over this table; re-importing never overwrites
 * either.
 */
export const KNOWN_STATION_COVERS: Readonly<Record<string, string>> = {
  "http://audiolive302.iqilu.com/sdradioShenghuo/sdradio04/playlist.m3u8": "https://pic.qtfm.cn/sso/198/1616046643828__L8tR-IeB.jpeg",
  "http://audiolive302.iqilu.com/sdradioYinyue/sdradio07/playlist.m3u8": "https://pic.qtfm.cn/sso/198/1616046817671_NvOcEhIBs.jpeg",
  "http://lhttp.qingting.fm/live/1886/64k.mp3": "https://pic.qtfm.cn/2016/0623/20160623160646692.png",
  "http://lhttp.qingting.fm/live/20021/64k.mp3": "https://pic.qtfm.cn/2025/0102/20250102010706.png",
  "http://lhttp.qingting.fm/live/5021912/64k.mp3": "https://pic.qtfm.cn/2022/0712/20220712122112.jpeg",
  "http://lhttp.qingting.fm/live/5022338/64k.mp3": "https://pic.qtfm.cn/sso/198/1601174358400_IFKY2op0y.jpeg",
  "http://lhttp.qingting.fm/live/5022391/64k.mp3": "https://pic.qtfm.cn/2020/1007/20201007035220.jpeg",
  "http://live.xmcdn.com/live/1878/64.m3u8": "https://pic.qtfm.cn/2023/0424/20230424033746.jpeg",
  "http://ls.qingting.fm/live/1185.m3u8": "https://pic.qtfm.cn/2024/0806/20240806043234.jpeg",
  "http://ls.qingting.fm/live/1297.m3u8": "https://pic.qtfm.cn/2017/0501/20170501063612.jpeg",
  "http://ls.qingting.fm/live/1606731.m3u8": "https://pic.qtfm.cn/2015/0325/20150325173305589.jpg",
  "http://ls.qingting.fm/live/1831.m3u8": "https://pic.qtfm.cn/2021/0730/20210730064142.jpeg",
  "http://ls.qingting.fm/live/23869.m3u8": "https://pic.qtfm.cn/2023/0731/20230731015613.png",
  "http://ls.qingting.fm/live/273.m3u8": "https://pic.qtfm.cn/2014/0909/20140909125130474.jpg",
  "http://ls.qingting.fm/live/274.m3u8": "https://pic.qtfm.cn/2014/0909/20140909123511693.jpg",
  "http://ls.qingting.fm/live/2782.m3u8": "https://pic.qtfm.cn/2015/0427/20150427150729661.png",
  "http://ls.qingting.fm/live/332.m3u8": "https://pic.qtfm.cn/2017/0424/20170424025444.jpeg",
  "http://ls.qingting.fm/live/4850.m3u8": "https://pic.qtfm.cn/2018/0305/20180305020802.jpeg",
  "http://rs.ajmide.com/r_10/10.m3u8": "https://pic.qtfm.cn/sso/48/1641437907698_k0NNOUP54.jpeg",
  "http://satellitepull.cnr.cn/live/wx32gxwygb/playlist.m3u8": "https://pic.qtfm.cn/2015/0225/20150225111148873.png",
  "http://satellitepull.cnr.cn/live/wx32gzyygb/playlist.m3u8": "https://pic.qtfm.cn/2020/0310/20200310111901.jpeg",
  "http://satellitepull.cnr.cn/live/wx32hljyygb/playlist.m3u8": "https://pic.qtfm.cn/sso/48/1638179327711_IlklMh2sV.jpeg",
  "http://satellitepull.cnr.cn/live/wx32hubyygb/playlist.m3u8": "https://pic.qtfm.cn/2018/0316/20180316022139.jpeg",
  "http://satellitepull.cnr.cn/live/wx32jsjdlxyy/playlist.m3u8": "https://pic.qtfm.cn/2017/0518/20170518065929.jpeg",
  "http://satellitepull.cnr.cn/live/wxahyygb/playlist.m3u8": "https://pic.qtfm.cn/2015/0209/20150209212414954.jpg",
  "http://satellitepull.cnr.cn/live/wxcqyygb/playlist.m3u8": "https://pic.qtfm.cn/2022/1130/20221130104320.jpeg",
  "http://satellitepull.cnr.cn/live/wxgdyyzs/playlist.m3u8": "https://pic.qtfm.cn/sso/198/1564454286057_EAoJdKLRT.jpeg",
  "http://satellitepull.cnr.cn/live/wxhainyygb/playlist.m3u8": "https://pic.qtfm.cn/2018/0326/20180326122700.png",
  "http://satellitepull.cnr.cn/live/wxszfy971/playlist.m3u8": "https://pic.qtfm.cn/2014/0330/20140330113445384.jpg",
  "http://satellitepull.cnr.cn/live/wxynyygb/playlist.m3u8": "https://pic.qtfm.cn/2020/0325/20200325122958.jpeg",
  "http://satellitepull.cnr.cn/live/wxzj968/playlist.m3u8": "https://pic.qtfm.cn/2020/0408/20200408094917.jpeg",
  "http://stream3.xiancity.cn/4/sd/live.m3u8": "https://pic.qtfm.cn/2015/0528/20150528101127365.jpg",
  "https://lhttp.qingting.fm/live/1144/64k.mp3": "https://pic.qtfm.cn/2021/0406/20210406123718.jpeg",
  "https://lhttp.qingting.fm/live/1223/64k.mp3": "https://pic.qtfm.cn/2022/0905/20220905030909.jpeg",
  "https://lhttp.qingting.fm/live/1654/64k.mp3": "https://pic.qtfm.cn/2018/1009/20181009063315.jpeg",
  "https://lhttp.qingting.fm/live/2803/64k.mp3": "https://pic.qtfm.cn/2022/1207/20221207091708.jpeg",
  "https://lhttp.qingting.fm/live/4581/64k.mp3": "https://pic.qtfm.cn/2022/1101/20221101031936.jpeg",
  "https://lhttp.qingting.fm/live/4915/64k.mp3": "https://pic.qtfm.cn/2022/0211/20220211102019.jpeg",
  "https://lhttp.qingting.fm/live/4923/64k.mp3": "https://pic.qtfm.cn/2023/0415/20230415115800.png",
  "https://lhttp.qingting.fm/live/4942/64k.mp3": "https://pic.qtfm.cn/2023/0504/20230504054309.png",
  "https://lhttp.qingting.fm/live/5021381/64k.mp3": "https://pic.qtfm.cn/2022/0115/20220115043946.gif",
  "https://lhttp.qingting.fm/live/5022038/64k.mp3": "https://pic.qtfm.cn/2024/0726/20240726111933.png",
  "https://lhttp.qingting.fm/live/5022405/64k.mp3": "https://pic.qtfm.cn/2022/0712/20220712122011.jpeg",
  "https://lhttp.qingting.fm/live/839/64k.mp3": "https://pic.qtfm.cn/2015/1210/20151210172937967.jpg",
};

/** Strip the parts that vary between revisions of the same playlist entry. */
function normalizeStreamUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

/**
 * Artwork for a stream URL, or "" when the station is not in the table.
 *
 * Matching ignores scheme and a trailing slash so the same station still
 * resolves after a list switches http→https or gains a slash. It never falls
 * back to name matching: that is precisely the guess that produced wrong logos.
 */
export function knownCoverFor(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const exact = KNOWN_STATION_COVERS[trimmed];
  if (exact) return exact;
  const want = normalizeStreamUrl(trimmed);
  for (const [key, cover] of Object.entries(KNOWN_STATION_COVERS)) {
    if (normalizeStreamUrl(key) === want) return cover;
  }
  return "";
}
