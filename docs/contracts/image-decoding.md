# 图片解码 / RAW 内嵌预览 契约

> 自研像素解码器：`src/main/image-decoders/`；RAW 内嵌预览：`src/main/raw-preview.js`
> **接入层唯一接线：`src/main/sharp-input.js`**（桌面端与网页端共用同一份）
> 守护：`image-decoders-regression`（39 项，自包含：样本用代码合成，不依赖 ffmpeg/Python/真库文件）
> 本文只记录**回归脚本断言不了的**：为什么要有这一层、哪些"证据"是假的、四条不抛异常的坑。

## 为什么有这一层

🔴 **libvips 8.15.3 实际只认 9 种输入**：`gif / heif / jpeg / png / raw / svg / tiff / vips / webp`。
判据**以实测为准** —— `sharp.format` 里的能力位与真实行为**不一致**。

而 `scanner.js#IMAGE_EXTENSIONS` 里一直写着 `.bmp` / `.ico` ⇒ 那是**空承诺**：
文件扫得进来、一张也出不了图。

### 🔴 别拿 `has_thumbnail` 的比例当「能读」的证据（本轮正是栽在这里）

- 真库「102 个 bmp 里 100 个 `has_thumbnail = 1`」是**历史遗留**，实测连那张 4160×3120
  现在也读不出来（重跑只会失败）。
- 原先按「真库 cr3 306/306 有缩略图」判定「cr3 能直接读」，实测却是
  `Input file contains unsupported image format`。

**识别历史遗留的判据**：同行 `thumb_size = 0` / `width = 0` / `height = 0` —— 真成功生成过
不可能三列全 0。⇒ 加进自研表后实测 CR3 可抠出 **8192×5464 / 2.63 MB** 的全尺寸预览。

🔴 **这条判据只能来自实测，不能用 `has_thumbnail` 的比例推断。**

### CR2 的根因是 libtiff 编译选项，不是 sharp 版本

CR2 是 TIFF 容器 + `Compression = 6`（old-style JPEG），libtiff 未启用 `OLD_JPEG`
⇒ 一律抛 `Old-style JPEG compression support is not configured`，prebuilt 一律不带。

⇒ `OWN_DECODER_RAW_EXTENSIONS` = `.cr2` / `.crw` / `.cr3`；判据是「**libvips 打不开**」，
**不是**「是不是 RAW」。`.dng`（真库 25/25）未实测到反例，仍走原生路径。

**覆盖范围**：BMP（1/4/8/16/24/32bpp、`BI_RGB`/`BI_RLE8`/`BI_RLE4`/`BI_BITFIELDS`、top-down）、
DIB、ICO/CUR、TGA（含 RLE/灰度/行序/镜像）、PNM/PAM（P1~P7）、QOI；
RAW 走 `raw-preview.js` 抠容器里那张全尺寸 JPEG + 用容器 IFD 读 EXIF。
新增到扫描白名单的扩展名：`.tga/.qoi/.pbm/.pgm/.ppm/.pnm/.pam/.dib`。

## 四条**静默**坑（全都实测踩到过，且都不抛异常）

1. **TGA 头撞 CUR 的 magic**：TGA 头前 4 字节 = `idLength, colorMapType, imageType, cmFirst低位`，
   `imageType=2` 时逐字节等于 **`00 00 02 00`**。旧代码据此判成 CUR，`decodeIco` 因 `count=0`
   返回 null 后**直接结束** ⇒ **整类 TGA 读不了**。
   修法是三件事**成套**：移掉 CUR magic 判定 + **扩展名优先于 magic** +
   **任一候选失败要 `continue`（不是 `return null`）**。单独改任一处都不会红。
2. **PNM 二进制漏跳 maxval 后那一个分隔空白**：不是「若是空白才跳」，规范**保证存在**这个字节
   ⇒ 必须无条件前进 1。症状是整张错位 1 字节（灰度渐变区相邻值差 ≤1，肉眼看不出），
   但实测 `p6.ppm` **56% 字节对不上**。
3. **TGA 灰度整张纯黑**：灰度（imageType 3/11）传进来的是**一个数字**，不是 `{r,g,b,a}`；
   走 `px.r` 得 `undefined` ⇒ 落成 0。不报错。
4. **RAW 容器 EXIF 入参形态传错**：`extractExifFields` 收的是 **sharp 的 metadata 对象**
   （`{ exif: <Buffer> }`），**不是**已解析好的 exif 对象。传错**不报错**：
   它走 `if (!metadata.exif) return out;` 返回全 null 的字段对象，而
   `Object.keys(fields).length` 对全 null 对象**恒为真** ⇒ **判空被骗过**。
   正确形态 `extractExifFields({ exif: buf })`，且判据必须换成 **`hasAnyExifField(fields)`**
   （「有没有任何字段真的取到值」）。

## 承重判据

- 🔴 **扩展名清单只允许一份**，唯一真相源 `sharp-input.js#OWN_DECODER_RAW_EXTENSIONS`。
  `raw-preview.js` 原先另存过一份 36 项的表（含 nef/arw/rw2/raf/x3f…），与真判据**不一致**
  （那些扩展名根本走不到那里）、在 `src/` 里**零使用者**，却有一条回归牙钉着它
  ⇒ **那条牙守的是没人用的清单（假绿）**。这是本项目的元规则：钉死代码的回归 = 假绿。
- 🔴 **SOF 类型区分不了预览与 RAW 数据块**（RAW 块头部同样写 `SOF0`）⇒ 只能靠**长度**：
  下限 32 KB（排除 IFD1 的 160×120 小缩略图）+ 上限 16 MB（排除 24.4 MB 的 RAW 块）
  + **占文件体积不得超过一半**（防探针截断漏洞）。
  实测样本：12 KB(160×120) / 1.89 MB(5760×3840，**取它**) / 24.4 MB(RAW 块)。
- 🔴 **CR2 内嵌预览段不带 APP1/EXIF**（实测三段全无）⇒ 绝不能指望
  `sharp(preview).metadata().exif`；而走兜底时 `header` 非 null 会写 `exif_mtime` 标记
  ⇒ 会把「没读到 EXIF」**永久**标记成「看过了、确实没有」。
- 🔴 **TGA 无 magic、ICO/CUR magic 会撞车** ⇒ 这两族只能按**扩展名**分流；BMP/PNM/QOI 仍按 magic。
  判据：`detectKind()` 里**只列 magic 不撞车的格式**。
- ⚠️ 承诺前必须先合成样本自证。维度取 `4×3`（**宽度不是 4 的倍数**）才能戳穿行 stride 对齐错误。

## 接入层：`sharp-input.js` 是唯一接线

- 🔴 桌面端（`main.js`）与网页端（`web-server.js`）**共用同一份**。两端各写必然漂移，
  症状是「**一端出图、另一端破图**」—— 两端都"看起来正常"，只是少了一部分图片。
- 🔴 网页端**不得自行 `require('sharp')`**：直接用 `sharp(path)` 会绕过兜底
  ⇒ cr2 在网页端永远 500、bmp 之类永远占位图。
- 🔴 「要不要转码」的判据**不是** `needsFallbackDecode`，而是 **`needsOwnRender`**：
  后者额外扣掉**浏览器原生能显示**的 `bmp / ico / cur`（libvips 读不了但浏览器认
  ⇒ 发原文件更快更清晰）。其余（tga/qoi/pnm/dib）浏览器也不认 ⇒ 直发就是破图
  （还会被标成 `image/jpeg`）。
- 🔴 网页端还有**第二张** RAW 清单 `web-server.js#RAW_EXTENSIONS`，语义不同
  （「按 RAW 对待：并发队列 / 独立缓存 / 2560px 预览档」）⇒ **不能与
  `OWN_DECODER_RAW_EXTENSIONS` 合并，但必须同步**。漏项的代价是**破图**：
  不在表里的 RAW 会落到 `handlePhoto` 的 `mimeMap`（那里没有它）⇒ 标成 `image/jpeg`
  却发的是原文件，浏览器解不出来且**一声不吭**。实测踩到过：`.cr3` / `.crw` 原先不在表里。
- 🔴 `handlePhoto(req,res,id,fromPreviewFallback)` 的**第四参必须传**：
  `handlePreviewImage` 失败会回落 `handlePhoto`，若不拦住就**互相回弹成死循环**
  （异步递归，不崩、不报错、只是无限重试）。

## 为什么不换用开源解码器（实测数字）

| 候选 | 实测结果 |
| --- | --- |
| `exifr 7.1.3` | `thumbnail(CR2)` 抛 `RangeError`，给不出预览 |
| `@napi-rs/image 1.15.0` | 27 个样本只过 15 个，且**读不了 tga/qoi/gif** |
| `bmp-js 0.1.0` | 像素错 55%（最大差 255），只支持 `compression=0` |

⇒ 继续自研 + **零新依赖**。

## 验收时的三个坑

1. **守护的 `check()` 必须支持 async**：否则 async 断言会同时产生**假红**
   （`promise.preview` 是 undefined）与**假绿**（`!promise.preview` 恒真，一条都没验）——
   最初就有一条守卫「占比闸门」的牙是假绿的。
2. **报告与临时文件清理必须在 `Promise.all(pending)` 之后**：否则 `unlink` 会抢在读盘之前
   删掉样本文件（表现为「应抠出预览」失败，真因是文件没了）。
3. **锚点别钉具体实现调用**：`photo-metadata-backfill-regression.js` 里的
   `var instance = loadSharp()(` 因接线收进 bridge 而**假红**（契约本身完好），
   且该文件**同一个错已犯两次**。⇒ 改成钉**行为链**（同一标识符被 `readHeaderMeta(...)`
   与 `resize` 共用、顺序不变）。
