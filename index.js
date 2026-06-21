const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const tough = require('tough-cookie');
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');

// ========== ffmpeg 路径设置 ==========
function setupFFmpeg() {
  let ffmpegPath = null;

  // 1. 优先使用 @ffmpeg-installer/ffmpeg 提供的 ffmpeg
  try {
    ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    if (fs.existsSync(ffmpegPath)) {
      ffmpeg.setFfmpegPath(ffmpegPath);
      console.log('✅ 使用 @ffmpeg-installer/ffmpeg:', ffmpegPath);
      
      // 2. 设置 ffprobe：尝试 @ffprobe-installer/ffprobe（与 ffmpeg 无关）
      let ffprobePath = null;
      try {
        ffprobePath = require('@ffprobe-installer/ffprobe').path;
        if (fs.existsSync(ffprobePath)) {
          ffmpeg.setFfprobePath(ffprobePath);
          console.log('✅ 使用 @ffprobe-installer/ffprobe:', ffprobePath);
        }
      } catch (e) {
        // 没装 @ffprobe-installer/ffprobe，再试同目录
        const maybeFfprobe = path.join(path.dirname(ffmpegPath), 'ffprobe.exe');
        if (fs.existsSync(maybeFfprobe)) {
          ffmpeg.setFfprobePath(maybeFfprobe);
          console.log('✅ 使用 ffmpeg 同目录下的 ffprobe:', maybeFfprobe);
        } else {
          console.warn('⚠️ 未找到 ffprobe.exe，无法自动检测视频流有效性');
        }
      }
      return;
    }
  } catch (e) {}

  // 降级到本地 ffmpeg.exe 和 ffprobe.exe（如果放在项目根目录）
  const localExe = path.resolve('./ffmpeg.exe');
  if (fs.existsSync(localExe)) {
    ffmpeg.setFfmpegPath(localExe);
    console.log('✅ 使用本地 ffmpeg.exe:', localExe);
    const localFfprobe = path.resolve('./ffprobe.exe');
    if (fs.existsSync(localFfprobe)) {
      ffmpeg.setFfprobePath(localFfprobe);
      console.log('✅ 使用本地 ffprobe.exe:', localFfprobe);
    } else {
      console.warn('⚠️ 未找到本地 ffprobe.exe，无法自动检测视频流有效性');
    }
    return;
  }

  console.warn('⚠️ 未找到任何 ffmpeg，请检查安装');
}
setupFFmpeg();

// ========== 常量 ==========
const COOKIE_PATH = path.resolve('./cookies.json');
const SAVE_DIR = path.resolve('./bilibili_videos');
fs.ensureDirSync(SAVE_DIR);

const qualityMap = {
  16: "360P 流畅",
  32: "480P 清晰",
  64: "720P 高清",
  80: "1080P 高清",
  112: "1080P60 高帧率(大会员)",
  116: "4K 超清(大会员)",
  120: "4K60 杜比视界(大会员)"
};

// 需要大会员才能使用的画质ID
const VIP_QUALITY_IDS = [112, 116, 120];

// ---------- Cookie 管理 ----------
const jar = new tough.CookieJar();

async function loadCookies() {
  if (await fs.pathExists(COOKIE_PATH)) {
    const raw = await fs.readFile(COOKIE_PATH, 'utf8');
    try {
      const cookieList = JSON.parse(raw);
      for (const c of cookieList) {
        const cookie = tough.Cookie.fromJSON(c);
        jar.setCookieSync(cookie, 'https://www.bilibili.com');
      }
    } catch (e) {}
  }
}

async function saveCookies() {
  const cookies = jar.getCookiesSync('https://www.bilibili.com');
  await fs.writeFile(COOKIE_PATH, JSON.stringify(cookies, null, 2), 'utf8');
}

function isLoggedIn() {
  const cookies = jar.getCookiesSync('https://www.bilibili.com');
  return cookies.some(c => c.key === 'SESSDATA');
}

// ---------- axios 实例 ----------
const http = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  }
});

http.interceptors.request.use(cfg => {
  const cookies = jar.getCookieStringSync(cfg.url || 'https://www.bilibili.com');
  if (cookies) cfg.headers.Cookie = cookies;
  return cfg;
});

http.interceptors.response.use(res => {
  const setCookies = res.headers['set-cookie'];
  if (setCookies) {
    for (const str of setCookies) {
      jar.setCookieSync(str, res.config.url);
    }
    saveCookies();
  }
  return res;
});

// ---------- Wbi 签名 ----------
let cachedMixinKey = null;
let mixinKeyExpire = 0;

async function getMixinKey() {
  const now = Date.now();
  if (cachedMixinKey && now < mixinKeyExpire) return cachedMixinKey;
  const { data } = await http.get('https://api.bilibili.com/x/web-interface/nav');
  const { img_url, sub_url } = data.data.wbi_img;
  const imgKey = img_url.split('/').pop().split('.')[0];
  const subKey = sub_url.split('/').pop().split('.')[0];
  cachedMixinKey = (imgKey + subKey).slice(0, 32);
  mixinKeyExpire = now + 3600000;
  return cachedMixinKey;
}

async function signParams(params) {
  const mixinKey = await getMixinKey();
  const wts = Math.floor(Date.now() / 1000);
  const allParams = { ...params, wts };
  const sortedKeys = Object.keys(allParams).sort();
  const query = sortedKeys
    .map(k => `${k}=${encodeURIComponent(allParams[k])}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return { ...allParams, w_rid: wRid };
}

// ---------- 解析BV ----------
function parseBV(input) {
  const m = input.match(/BV([A-Za-z0-9]{10})/);
  if (!m) throw new Error('无法识别BV号，请输入纯BV号或包含BV号的链接');
  return `BV${m[1]}`;
}

// ---------- 获取视频信息 ----------
async function getVideoInfo(bv) {
  const res = await http.get(`https://www.bilibili.com/video/${bv}`);
  const $ = cheerio.load(res.data);

  // 方法1：__INITIAL_STATE__
  const initialScript = $('script:contains("window.__INITIAL_STATE__")').html();
  if (initialScript) {
    const match = initialScript.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\});/s);
    if (match) {
      try {
        const initData = JSON.parse(match[1]);
        if (initData.videoData) {
          const { aid, cid, title, pages } = initData.videoData;
          return { title, aid, cid, pages, bv };
        }
      } catch (e) { console.warn('解析 INITIAL_STATE 失败', e.message); }
    }
  }

  // 方法2：__playinfo__
  const playInfoScript = $('script:contains("window.__playinfo__=")').html();
  if (playInfoScript) {
    const match = playInfoScript.match(/window\.__playinfo__\s*=\s*(\{.*?\});/s);
    if (match) {
      try {
        const playInfo = JSON.parse(match[1]);
        const title = $('h1.title').text().trim() || '未知标题';
        return { title, aid: playInfo.aid, cid: playInfo.cid, pages: [], bv };
      } catch (e) {}
    }
  }

  // 方法3：接口降级
  const params = await signParams({ bvid: bv });
  const { data } = await http.get('https://api.bilibili.com/x/web-interface/view', { params });
  if (data.code !== 0) throw new Error(`获取视频信息失败: ${data.message}`);
  const { aid, cid, title, pages } = data.data;
  return { title, aid, cid, pages, bv };
}

// ---------- 获取播放地址 ----------
async function getPlayData(bv, cid) {
  const baseParams = {
    bvid: bv,
    cid,
    qn: 120,
    fnval: 16 | 4048,
    fourk: 1,
    platform: 'web'
  };

  // 新wbi接口
  try {
    const signed = await signParams(baseParams);
    const res = await http.get('https://api.bilibili.com/x/player/wbi/playurl', {
      params: signed,
      headers: { Referer: 'https://www.bilibili.com' }
    });
    if (res.data.code === 0 && res.data.data) {
      console.log('✓ 使用 wbi 播放接口');
      return res.data.data;
    }
    console.warn('wbi接口返回错误:', res.data.message);
  } catch (e) {
    console.warn('wbi接口请求异常:', e.message);
  }

  // 降级旧接口
  console.log('尝试旧版播放接口...');
  const oldParams = { bvid: bv, cid, fnval: 16, platform: 'web' };
  const signedOld = await signParams(oldParams);
  const oldRes = await http.get('https://api.bilibili.com/x/player/playurl', {
    params: signedOld,
    headers: { Referer: 'https://www.bilibili.com' }
  });
  if (oldRes.data.code !== 0) throw new Error(`旧播放接口失败: ${oldRes.data.message}`);
  return oldRes.data.data;
}
async function getPlayDataFlv(bv, cid) {
  const baseParams = { bvid: bv, cid, qn: 80, fnval: 1, platform: 'web' };
  const signed = await signParams(baseParams);
  const res = await http.get('https://api.bilibili.com/x/player/wbi/playurl', {
    params: signed,
    headers: { Referer: 'https://www.bilibili.com' }
  });
  if (res.data.code !== 0) throw new Error(`FLV 接口错误: ${res.data.message}`);
  return res.data.data;
}

// ---------- 选择流（支持手动指定画质）----------
function chooseStream(playData, targetQuality = 0, loggedIn = false) {
  if (playData.dash && playData.dash.video && playData.dash.audio) {
    // 🛡️ 过滤掉纯音频伪装的“视频流”：只保留包含视频编码的条目
    const videoCodecPattern = /avc|hev|vp9|av1|h\.?264|h\.?265/i;
    let videos = playData.dash.video
	  .filter(v => {
		// 必须 mimeType 包含 video/，且 codecs 包含视频编码
		const isVideoMime = v.mimeType && v.mimeType.startsWith('video/');
		const hasVideoCodec = v.codecs && /avc|hev|vp9|av1|h\.?264|h\.?265/i.test(v.codecs);
		return isVideoMime && hasVideoCodec;
	  });
    
    if (videos.length === 0) {
      // 如果过滤后没了，则降级使用全部视频流（并给出警告）
      console.warn('⚠️ 未找到包含视频编码的流，将使用所有可用视频流（可能仅音频）');
      videos = playData.dash.video;
    }
    
    videos.sort((a, b) => b.bandwidth - a.bandwidth);
    const audios = playData.dash.audio.sort((a, b) => b.bandwidth - a.bandwidth);

    console.log("\n======== DASH 可用清晰度 ========");
    videos.forEach(v => {
      const name = qualityMap[v.id] || `未知ID:${v.id}`;
      const vipMark = VIP_QUALITY_IDS.includes(v.id) ? ' 🔒(需大会员)' : '';
      console.log(`ID:${v.id}  ${name}${vipMark}  |  码率:${(v.bandwidth/1000).toFixed(0)} kbps`);
    });

    let chosenVideo;
    if (targetQuality > 0) {
      chosenVideo = videos.find(v => v.id === targetQuality);
      if (!chosenVideo) {
        console.warn(`⚠️ 指定画质 ID ${targetQuality} 不可用，回退到最高可用画质`);
        chosenVideo = videos[0];
      } else {
        if (VIP_QUALITY_IDS.includes(targetQuality) && !loggedIn) {
          console.warn('⚠️ 未登录状态下无法下载大会员专属画质，已自动降级到最高可用画质');
          chosenVideo = videos[0];
        }
      }
    } else {
      // 自动最高
      if (!loggedIn) {
        const nonVip = videos.filter(v => !VIP_QUALITY_IDS.includes(v.id));
        chosenVideo = nonVip.length > 0 ? nonVip[0] : videos[0];
        if (nonVip.length === 0) {
          console.warn('⚠️ 该视频仅有大会员画质，但未登录，可能无法正常下载');
        }
      } else {
        chosenVideo = videos[0];
      }
    }

    const bestAudio = audios[0];
    const chosenName = qualityMap[chosenVideo.id] || `画质ID:${chosenVideo.id}`;
    console.log(`✅ 选择视频: ${chosenName}, 音频码率:${(bestAudio.bandwidth/1000).toFixed(0)}kbps\n`);

    return {
      type: 'dash',
      videoUrl: chosenVideo.baseUrl,
      audioUrl: bestAudio.baseUrl,
	  videoList: videos   // 把所有可用视频流都带出去，用于降级尝试
    };
  }

  // FLV 部分保持不变...
  if (playData.durl && playData.durl.length > 0) {
    console.log("📼 检测到非 DASH 流 (FLV)，将直接下载");
    const best = playData.durl.sort((a, b) => b.size - a.size)[0];
    console.log(`✅ 选择画质: ${qualityMap[playData.quality] || '未知'}\n`);
    return {
      type: 'flv',
      url: best.url
    };
  }

  throw new Error('未找到可用视频流');
}

// ---------- 下载文件 ----------
async function downloadFile(url, filePath, label) {
  const axiosDown = axios.create();
  let remoteTotal = 0;
  try {
    const headRes = await axiosDown.head(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' },
      timeout: 10000
    });
    remoteTotal = parseInt(headRes.headers['content-length'], 10) || 0;
  } catch (e) {}

  if (remoteTotal > 0 && fs.existsSync(filePath)) {
    if (fs.statSync(filePath).size >= remoteTotal) {
      console.log(`  ✅ ${label} 已完整下载，跳过`);
      return;
    }
  }

  let existingSize = 0;
  if (fs.existsSync(filePath)) {
    existingSize = fs.statSync(filePath).size;
  }

  const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' };
  if (existingSize > 0 && remoteTotal > 0 && existingSize < remoteTotal) {
    headers['Range'] = `bytes=${existingSize}-`;
    console.log(`  ↪ ${label} 断点续传，已有 ${(existingSize/1024).toFixed(0)} KB`);
  }

  let res;
  try {
    res = await axiosDown.get(url, { responseType: 'stream', headers, timeout: 60000 });
  } catch (err) {
    if (err.response && err.response.status === 416) {
      console.log(`  ✅ ${label} 已完整 (服务器返回416)，跳过下载`);
      return;
    }
    throw err;
  }

  const contentLength = parseInt(res.headers['content-length'], 10);
  const totalSize = existingSize + (contentLength || 0);
  let downloaded = existingSize;

  const writer = fs.createWriteStream(filePath, { flags: existingSize > 0 ? 'a' : 'w' });
  res.data.on('data', chunk => {
    downloaded += chunk.length;
    if (totalSize) {
      process.stdout.write(`\r  ${label}: ${((downloaded / totalSize) * 100).toFixed(1)}%  ${(downloaded/1024/1024).toFixed(1)} MB`);
    }
  });

  res.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', () => { console.log(`\n  ✅ ${label} 下载完成`); resolve(); });
    writer.on('error', reject);
    res.data.on('error', reject);
  });
}

// ---------- 合并音视频 ----------
async function mergeAV(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    // 先分析视频流的编码格式
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(new Error('无法分析视频流'));
        return;
      }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const isHevc = videoStream && videoStream.codec_name === 'hevc';

      const command = ffmpeg()
        .input(videoPath)
        .input(audioPath);

      if (isHevc) {
        // HEVC → 转成 H.264（需要时间）
        console.log('检测到 HEVC 视频，转换为 H.264...');
        command.outputOptions([
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-c:a', 'aac'
        ]);
      } else {
        // H.264/其他 → 直接复制（秒级完成）
        console.log('视频为 H.264，快速合并...');
        command.outputOptions('-c', 'copy');
      }

      command.output(outputPath)
        .on('end', async () => {
          await fs.unlink(videoPath).catch(() => {});
          await fs.unlink(audioPath).catch(() => {});
          resolve();
        })
        .on('error', reject)
        .run();
    });
  });
}
// 检测视频文件是否包含视频轨道
function hasVideoTrack(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.warn('ffprobe 检查失败:', err.message);
        return resolve(false);
      }
      const hasVideo = metadata.streams.some(s => s.codec_type === 'video');
      resolve(hasVideo);
    });
  });
}
// ---------- 登录Cookie设置 ----------
async function setLoginCookie(sessdata, biliJct, uid) {
  const domain = '.bilibili.com';
  jar.setCookieSync(`SESSDATA=${sessdata}; Domain=${domain}; Path=/`, 'https://www.bilibili.com');
  jar.setCookieSync(`bili_jct=${biliJct}; Domain=${domain}; Path=/`, 'https://www.bilibili.com');
  jar.setCookieSync(`DedeUserID=${uid}; Domain=${domain}; Path=/`, 'https://www.bilibili.com');
  await saveCookies();
  console.log('✅ 登录Cookie已保存');
}

// ---------- 主下载函数 ----------
async function downloadVideo(input, pageIdx = 0, qualityId = 0) {
  await loadCookies();
  const loggedIn = isLoggedIn();
  if (loggedIn) {
    console.log('🔑 已检测到登录状态，可用更高画质');
  } else {
    console.log('👤 未登录，仅能下载普通画质（最高1080P），大会员画质将自动过滤');
  }

  const bv = parseBV(input);
  console.log(`✅ BV号: ${bv}`);

  const info = await getVideoInfo(bv);
  let { title, cid, pages } = info;

  if (pages && pages.length > 1) {
    console.log(`📚 共 ${pages.length} 个分P:`);
    pages.forEach((p, i) => console.log(`  ${i+1}. ${p.part} (cid:${p.cid})`));
    if (pageIdx > 0 && pageIdx <= pages.length) {
      const selected = pages[pageIdx - 1];
      cid = selected.cid;
      title = `${title} - P${pageIdx} ${selected.part}`;
    } else {
      console.log('(默认下载第1P)');
    }
  }

  console.log(`🎬 标题: ${title}`);
  const safeTitle = title.replace(/[\/\\:*?"<>|]/g, '_');

  const playData = await getPlayData(bv, cid);
  const stream = chooseStream(playData, qualityId, loggedIn);

  if (stream.type === 'dash') {
	  const audioUrl = stream.audioUrl;
	  const aTemp = path.resolve(SAVE_DIR, `temp_${bv}_${cid}_audio.m4s`);
	  const outFile = path.resolve(SAVE_DIR, `${safeTitle}.mp4`);

	  // 下载音频（只需一次）
	  await downloadFile(audioUrl, aTemp, '音频流');

	  let success = false;
	  let currentVideoList = stream.videoList;
	  let triedUrls = new Set();

	  // 尝试逐个视频流，直到找到有画面的
	  for (const videoItem of currentVideoList) {
		if (triedUrls.has(videoItem.baseUrl)) continue;
		triedUrls.add(videoItem.baseUrl);

		const vTemp = path.resolve(SAVE_DIR, `temp_${bv}_${cid}_video.m4s`);
		console.log(`🎯 尝试视频流: ID=${videoItem.id}, 码率=${(videoItem.bandwidth/1000).toFixed(0)}kbps`);
		await downloadFile(videoItem.baseUrl, vTemp, '视频流');

		// 检查是否真的包含视频轨道
		const hasVideo = await hasVideoTrack(vTemp);
		if (!hasVideo) {
		  console.warn('⚠️ 该视频流无画面，删除并尝试下一个...');
		  await fs.unlink(vTemp).catch(() => {});
		  continue;
		}

		// 合并
		console.log('🔧 合并中...');
		await mergeAV(vTemp, aTemp, outFile);
		success = true;
		break;
	  }

	  if (!success) {
			console.warn('⚠️ 所有 DASH 视频流均无效，自动尝试 FLV 流...');
			// 只删除一次音频临时文件
			await fs.unlink(aTemp).catch(() => {});

			const flvPlayData = await getPlayDataFlv(bv, cid);
			const flvStream = chooseStream(flvPlayData, qualityId, loggedIn);
			if (flvStream.type !== 'flv') {
				throw new Error('无法获取 FLV 流，下载失败');
			}
			const outFile = path.resolve(SAVE_DIR, `${safeTitle}.mp4`);
			await downloadFile(flvStream.url, outFile, '视频(FLV)');
			console.log(`🎉 完成: ${outFile}`);
			return;
		}

	  console.log(`🎉 完成: ${outFile}`);
	}
}

// ---------- 命令行入口 ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(`
📘 哔哩哔哩视频下载器 (B站视频下载)

用法：
  node index.js <BV号或包含BV的链接> [选项]

选项：
  -p <页码>        下载指定分P（从1开始，默认下载第1P）
  -q <画质ID>      手动指定画质（如 -q 80 指定1080P）
  
Cookie设置：
  node index.js cookie <SESSDATA> <bili_jct> <DedeUserID>

示例：
  node index.js BV1ptLX6fECu                  # 下载默认第1P，自动最高画质
  node index.js BV1ptLX6fECu -p 2             # 下载第2P
  node index.js BV1ptLX6fECu -q 64            # 下载720P
  node index.js BV1ptLX6fECu -p 2 -q 80       # 下载第2P的1080P
  node index.js "https://www.bilibili.com/video/BV1ptLX6fECu" -q 80   # 使用完整链接也可

画质ID对照表：
  16 : 360P 流畅
  32 : 480P 清晰
  64 : 720P 高清
  80 : 1080P 高清
  112: 1080P60 高帧率 (大会员)
  116: 4K 超清 (大会员)
  120: 4K60 杜比视界 (大会员)

提示：
  - 未登录最高只能下载1080P，登录后（设置Cookie）可下载大会员画质。
  - 设置Cookie的方法请查看 README 或运行 node index.js cookie 查看示例。
`);
    process.exit(0);
  }

  // 解析参数
  let mode = 'download';
  let input = '';
  let pageIdx = 0;
  let qualityId = 0;

  // 处理 cookie 模式
  if (args[0] === 'cookie') {
    if (args.length < 4) {
      console.log('❌ 参数不足，格式: node index.js cookie <SESSDATA> <bili_jct> <DedeUserID>');
      process.exit(1);
    }
    setLoginCookie(args[1], args[2], args[3]);
    process.exit(0);
  }

  // 下载模式
  input = args[0];
  let i = 1;
  while (i < args.length) {
    if (args[i] === '-p' && i + 1 < args.length) {
      pageIdx = parseInt(args[i + 1], 10);
      i += 2;
    } else if (args[i] === '-q' && i + 1 < args.length) {
      qualityId = parseInt(args[i + 1], 10);
      i += 2;
    } else {
      console.warn(`⚠️ 未知参数或格式错误: ${args[i]}`);
      i++;
    }
  }

  downloadVideo(input, pageIdx, qualityId).catch(err => {
    console.error('❌ 下载失败:', err.message);
  });
}
