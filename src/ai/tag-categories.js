'use strict';

/**
 * JoyTag 标签的**主题分类体系** —— 标签导航页「分类 → 子类 → 标签」三级树的唯一真相源。
 *
 * ## 这份文件解决什么问题
 *
 * `joytag-labels.txt` 的 5813 个标签是**扁平**的、按维度下标排的（`1girl` 在最前、
 * 冷门画师名散在中间）。扁平列表没法当导航用：用户想「找所有和头发有关的标签」时，
 * 无处可点。所以需要一层**稳定、可审计、可复现**的主题分类叠在它上面。
 *
 * ## 三条硬约束
 *
 * ① **全量覆盖**：`labels()` 的每一个标签都必须落到恰好一个子类。漏一个 = 导航页里
 *    那个标签**永远搜不到也点不开**，而且不报错 —— 静默丢失。
 * ② **规则按「下划线边界短语」匹配，不按裸子串**：标签用 `_` 分段，规则里的 token
 *    必须落在段边界上（可以跨段，但不能跨越段边界）才算命中。`ai/tag-labels.js` 里
 *    记着第一版分类脚本踩的坑：裸子串匹配让 `hololive` 被 `loli` 命中、
 *    把 `lolita_fashion` 误杀。边界短语天然避开这一类，同时还能让
 *    `long_sleeves` 命中 `puffy_long_sleeves`（第一版要求「恰好一整段」，
 *    结果多段 token 全部失效，`other` 桶积到 42%）。引擎见 `phrasesOf`。
 * ③ **顺序即优先级，首个命中生效**：规则表是**有序**的，越具体的规则越靠前
 *    （`school_uniform` 必须落「制服」而不是「学校场景」）。所以改规则表要当心顺序，
 *    别把通配的规则插到前面去。
 *
 * ## 分类名的两个来源（`label` 是**兜底**，不是权威）
 *
 * 这里给**稳定的机器 id**（`person` / `appearance` / …）＋一个**中文兜底名** `label`。
 * 界面上的显示名**优先取 i18n 词条**（渲染端 `tagnav.cat.<id>`、网页端同名），
 * 取不到才回落到这里的 `label` —— 与工程里既有的 `tUi(key, zhFallback)` 是同一套取向。
 *
 * 为什么不干脆把中文名留在这份文件里当权威：工程有「零裸中文」守护
 * （`scripts/background-tasks-panel-regression.js` ④b/④c），界面文案一律不许硬编码，
 * 而这是**数据层**。做成兜底两头都成立：数据层自解释（报告/守护里直接可读），
 * 界面层仍走 i18n。⚠️ 所以 `label` 的改动**不会**改变界面显示 —— 改显示名要改 i18n 两包。
 *
 * ## `other` 是**有预算的**，不是垃圾桶
 *
 * 规则没命中的落 `other`。它必须存在（新标签表总会有没见过的词），但守护把它的
 * **数量上限钉死**：规则退化（比如某条 token 被改错）会让标签大批漏进 `other`，
 * 那时上限断言就会红。这比「断言 other === 0」现实：后者会逼人为了凑 0 写一堆
 * 只命中一个标签的特例，反而是不可维护的。
 */

const { labels } = require('./tag-labels');

/** 顶层分类（**顺序 = 界面上的展示顺序**，也是报告的列序）。 */
const CATEGORIES = [
  { id: 'person', label: '人物与人数' },
  { id: 'appearance', label: '外貌与发型' },
  { id: 'expression', label: '表情与视线' },
  { id: 'clothing', label: '服饰与穿戴' },
  { id: 'pose', label: '动作与姿势' },
  { id: 'scene', label: '场景与背景' },
  { id: 'object', label: '物件与道具' },
  { id: 'work', label: '作品与角色' },
  { id: 'creator', label: '画师与来源' },
  { id: 'composition', label: '构图与视角' },
  { id: 'style', label: '画风与画质' },
  { id: 'event', label: '主题与纪念日' },
  { id: 'adult', label: '成人内容' },
  { id: 'other', label: '其他' },
];

/**
 * 子类。`id` 全局唯一（跨顶层也唯一），界面上的树第二级就是它。
 *
 * ⚠️ `id` 是**持久化值**：它会进入 URL/导航位置（`view=tag&sub=<id>`），
 * 改名等于让历史位置失效。要改就同时改 `nav-history` 的映射与守护。
 */
const SUBS = [
  // 人物与人数
  { id: 'count', label: '人数与合拍', category: 'person' },
  { id: 'gender', label: '性别', category: 'person' },
  { id: 'age', label: '年龄', category: 'person' },
  { id: 'body', label: '体型与身体', category: 'person' },
  { id: 'identity', label: '身份与职业', category: 'person' },
  { id: 'skin', label: '肤色', category: 'person' },

  // 外貌与发型
  { id: 'hair', label: '发型与发色', category: 'appearance' },
  { id: 'eyes', label: '眼睛', category: 'appearance' },
  { id: 'face', label: '面部特征', category: 'appearance' },
  { id: 'animal_ear', label: '兽耳与尾巴', category: 'appearance' },
  { id: 'wing_horn', label: '翅膀与角', category: 'appearance' },

  // 表情与视线
  { id: 'expression', label: '表情', category: 'expression' },
  { id: 'emoticon', label: '表情符号', category: 'expression' },
  { id: 'gaze', label: '视线与朝向', category: 'expression' },
  { id: 'mouth', label: '嘴部动作', category: 'expression' },

  // 服饰与穿戴
  { id: 'clothes_top', label: '上衣', category: 'clothing' },
  { id: 'clothes_bottom', label: '下装', category: 'clothing' },
  { id: 'clothes_full', label: '整身服装', category: 'clothing' },
  { id: 'uniform', label: '制服与职业装', category: 'clothing' },
  { id: 'legwear', label: '腿部穿戴', category: 'clothing' },
  { id: 'footwear', label: '鞋靴', category: 'clothing' },
  { id: 'headwear', label: '头饰', category: 'clothing' },
  { id: 'handwear', label: '手部穿戴', category: 'clothing' },
  { id: 'accessory', label: '饰品', category: 'clothing' },
  { id: 'innerwear', label: '内衣', category: 'clothing' },
  { id: 'swimwear', label: '泳装', category: 'clothing' },
  { id: 'pattern', label: '纹样与剪裁', category: 'clothing' },

  // 动作与姿势
  { id: 'posture', label: '姿态', category: 'pose' },
  { id: 'hand_action', label: '手与手臂动作', category: 'pose' },
  { id: 'leg_action', label: '腿部动作', category: 'pose' },
  { id: 'action', label: '行为与互动', category: 'pose' },

  // 场景与背景
  { id: 'indoor', label: '室内', category: 'scene' },
  { id: 'outdoor', label: '室外与自然', category: 'scene' },
  { id: 'city', label: '城市与建筑', category: 'scene' },
  { id: 'sky_time', label: '天空与时间', category: 'scene' },
  { id: 'weather', label: '天气与季节', category: 'scene' },
  { id: 'background', label: '背景与底色', category: 'scene' },
  { id: 'element', label: '自然元素与特效', category: 'scene' },

  // 物件与道具
  { id: 'weapon', label: '武器与装备', category: 'object' },
  { id: 'food', label: '食物与饮品', category: 'object' },
  { id: 'plant', label: '植物与花', category: 'object' },
  { id: 'animal', label: '动物', category: 'object' },
  { id: 'tool', label: '器物与文具', category: 'object' },
  { id: 'furniture', label: '家具与家居', category: 'object' },
  { id: 'music', label: '乐器与音响', category: 'object' },
  { id: 'vehicle', label: '交通工具', category: 'object' },
  { id: 'toy', label: '玩偶与玩具', category: 'object' },
  { id: 'media_text', label: '文字与画面内的媒体', category: 'object' },

  // 作品与角色
  { id: 'series', label: '作品', category: 'work' },
  { id: 'character', label: '角色', category: 'work' },
  { id: 'cosplay', label: '角色扮演', category: 'work' },
  { id: 'trope', label: '题材与设定', category: 'work' },

  // 画师与来源
  //
  // ⚠️ 这里**只有一个子类**，是有意的：`_(artist)` 这种形态在标签表里**一条都没有**
  //    （全表 5813 个标签里 `_(artist)` 命中 0）—— 画师名在 JoyTag 里就是光秃秃的单词
  //    （`wlop` 这类），没有可判据的形态。硬造一个「画师」子类只会得到一个**空节点**
  //    （界面上点不开），所以合并进「画师与来源」，等真有画师名清单时再拆出来。
  //    这条经验来自本文件第一次跑守护：它直接报了「子类 artist 一个标签都没有」。
  { id: 'source', label: '画师与来源', category: 'creator' },

  // 构图与视角
  { id: 'shot', label: '景别', category: 'composition' },
  { id: 'angle', label: '视角与方位', category: 'composition' },
  { id: 'framing', label: '构图与画面结构', category: 'composition' },

  // 画风与画质
  { id: 'medium', label: '媒介与技法', category: 'style' },
  { id: 'render', label: '渲染风格', category: 'style' },
  { id: 'quality', label: '画质与瑕疵', category: 'style' },
  { id: 'palette', label: '色彩与色调', category: 'style' },

  // 主题与纪念日
  { id: 'day', label: '纪念日', category: 'event' },
  { id: 'holiday', label: '节日与活动', category: 'event' },

  // 成人内容
  { id: 'nudity', label: '裸露', category: 'adult' },
  { id: 'sexual', label: '性行为与性暗示', category: 'adult' },
  { id: 'fetish', label: '特殊偏好', category: 'adult' },
  { id: 'censored', label: '审查与修正', category: 'adult' },

  // 兜底
  { id: 'other', label: '其他', category: 'other' },
];

/**
 * 规则表。**有序**：自上而下第一个命中的生效。
 *
 * 每条规则给三种匹配方式，任一命中即算：
 *   - `seg`：**下划线边界短语**清单（推荐；可跨段，不可跨边界）
 *   - `re` ：整条标签的正则（表达「数字开头」这类形态）
 *   - `full`：**整条标签相等**的清单（用于语义上确实特殊、短语匹配会误伤的词）
 *
 * ⚠️ 写规则时的两条纪律：
 *   1. **先具体后宽泛**。例：`school_uniform` 必须在 `school` 那条之前被「制服」接住。
 *   2. **短语匹配不是子串匹配**。`hair` 能接住 `long_hair`，但接不住 `hairband`
 *      （那是头饰）—— 要接住它得把 `hairband` 写进规则或让头饰规则更靠前。
 *      这不是缺陷，是**故意的**：让误伤变成「需要显式列出」，而不是悄悄发生。
 */
const RULES = [
  // ---------- 表情符号（最先：它们的词形和其他规则完全不相交，放哪儿都一样） ----------
  { sub: 'emoticon', re: /^[^a-z0-9]+$/ },
  { sub: 'emoticon', re: /^[:;][a-z0-9<>()]+$/ },

  // ---------- 结构化括号规则（最先，因为形态最确定） ----------
  { sub: 'source', re: /^(artist_name|twitter_username|web_address|bad_id|bad_pixiv_id|bad_twitter_id|bad_link|commentary|commentary_request)$/ },
  { sub: 'medium', re: /_\(medium\)$/ },
  { sub: 'cosplay', re: /_\(cosplay\)$/ },
  // `_(artist)` 在标签表里命中 0（见 SUBS 里那条注释）⇒ 规则也去掉，不留空转的规则。

  // ---------- 作品与角色（先于「外貌/服饰」，因为 `*_(series)` 里的词会误伤） ----------
  { sub: 'series', re: /_\(series\)$/ },
  // `name_(作品名)` 是 danbooru 的角色命名法 ⇒ 默认落「角色」。
  // ⚠️ 括号内容必须允许**下划线**：`zhongli_(genshin_impact)` 这种是绝大多数，
  //    第一版写成 `[a-z0-9'.\-]` ⇒ 500+ 个角色标签全漏到 `other`。
  { sub: 'character', re: /_\([^)]+\)$/ },

  // ---------- 成人内容（先于人体/服饰，否则 `nude` 会被身体规则抢走） ----------
  { sub: 'censored', seg: ['censored', 'uncensored', 'mosaic_censoring', 'bar_censor', 'light_bar_censor', 'convenient_censoring'] },
  { sub: 'sexual', seg: ['sex', 'sexual', 'penetration', 'fellatio', 'paizuri', 'handjob', 'footjob', 'masturbation', 'ejaculation', 'cum', 'semen', 'orgasm', 'anal', 'rape', 'tentacles', 'group_sex', 'after_sex', 'clothed_sex', 'sex_toy', 'dildo', 'vibrator', 'onahole', 'sexually_suggestive'] },
  { sub: 'nudity', seg: ['nude', 'naked', 'topless', 'bottomless', 'undressing', 'nipples', 'areolae', 'areola', 'pussy', 'penis', 'anus', 'pubic_hair', 'crotch', 'underboob', 'sideboob', 'downblouse', 'upskirt', 'no_bra', 'no_panties', 'wardrobe_malfunction', 'completely_nude', 'covered_nipples', 'puffy_nipples', 'inverted_nipples', 'veiny_penis', 'multiple_penises', 'spread_pussy', 'pussy_juice', 'female_pubic_hair', 'male_pubic_hair', 'areola_slip', 'thigh_gap', 'bulge', 'lactation'] },
  { sub: 'fetish', seg: ['bondage', 'shibari', 'blindfold', 'gag', 'leash', 'collar_and_leash', 'futanari', 'futa', 'dickgirl', 'shemale', 'wet_clothes', 'see-through', 'transparent_clothing', 'guro', 'blood', 'blood_on_face', 'gore', 'snuff', 'tickling', 'vore'] },

  // ---------- 构图与视角 ----------
  { sub: 'shot', seg: ['close-up', 'full_body', 'upper_body', 'lower_body', 'portrait', 'cowboy_shot', 'waist_up', 'wide_shot', 'extreme_close-up', 'feet_out_of_frame', 'head_out_of_frame'] },
  { sub: 'angle', seg: ['from_above', 'from_below', 'from_side', 'from_behind', 'from_outside', 'dutch_angle', 'profile', 'three_quarter_view', 'facing_viewer', 'facing_away', 'from_above_close-up', 'vanishing_point', 'fisheye'] },
  { sub: 'framing', seg: ['symmetry', 'symmetric_docking', 'docking', 'framed', 'out_of_frame', 'border', 'letterboxed', 'pillarboxed', 'cropped', 'panel', 'multiple_views', 'sketch_page', 'speech_bubble', 'thought_bubble', 'caption', 'english_text', 'watermark'] },

  // ---------- 画风与画质 ----------
  { sub: 'media_text', seg: ['comic', 'manga', '4koma', 'screenshot', 'game_screenshot', 'tegaki', 'doujinshi', 'illustration', 'cover', 'poster', 'manga_cover', 'light_novel', 'widescreen'] },
  { sub: 'quality', seg: ['highres', 'absurdres', 'lowres', 'jpeg_artifacts', 'bad_anatomy', 'bad_proportions', 'bad_hands', 'bad_feet', 'bad_face', 'bad_id', 'sketch', 'lineart', 'rough', 'unfinished', 'blurry', 'noisy', 'speckles', 'sketchy'] },
  { sub: 'palette', seg: ['monochrome', 'greyscale', 'grayscale', 'spot_color', 'sepia', 'limited_palette', 'pastel_colors', 'rainbow', 'colorful', 'two-tone', 'multicolored', 'pale_color', 'neon'] },
  { sub: 'render', seg: ['3d', 'realistic', 'photorealistic', 'pixel_art', 'chibi', 'stylized', 'traditional_media', 'vector', 'cel_shading', 'flat_color', 'airbrush', 'gradient', 'oil_painting', 'watercolor', 'marker', 'crayon', 'chalk', 'acrylic'] },

  // ---------- 主题与纪念日 ----------
  { sub: 'day', seg: ['day'] },
  { sub: 'holiday', seg: ['christmas', 'halloween', 'valentine', 'valentine\'s_day', 'new_year', 'birthday', 'easter', 'tanabata', 'thanksgiving', 'hanukkah'] },

  // ---------- 人物与人数 ----------
  { sub: 'count', re: /^\d+\+?(girls?|boys?)$/ },
  { sub: 'count', seg: ['solo', 'multiple_girls', 'multiple_boys', 'multiple_people', 'everyone', 'group', 'crowd', 'pair', 'solo_focus', 'besides_solo'] },
  { sub: 'gender', seg: ['male', 'female', 'androgynous', 'male_only', 'female_only', 'girl', 'boy', 'man', 'woman', 'men', 'women', 'ladies', 'gentlemen'] },
  { sub: 'age', seg: ['child', 'children', 'young', 'old', 'elderly', 'adult', 'baby', 'infant', 'toddler', 'teenage', 'middle_aged', 'aged_up', 'aged_down'] },
  { sub: 'skin', seg: ['dark-skinned_female', 'dark-skinned_male', 'dark_skin', 'pale_skin', 'tan', 'tanned', 'tanlines', 'skindentation'] },
  
  { sub: 'body', seg: ['breasts', 'large_breasts', 'medium_breasts', 'small_breasts', 'flat_chest', 'huge_breasts', 'navel', 'cleavage', 'abs', 'stomach', 'waist', 'hips', 'thighs', 'thigh', 'legs', 'leg', 'arms', 'arm', 'hands', 'hand', 'fingers', 'fingernails', 'toenails', 'neck', 'shoulders', 'shoulder', 'back', 'butt', 'ass', 'collarbone', 'knees', 'knee', 'elbow', 'ankles', 'ankle', 'wrists', 'wrist', 'feet', 'foot', 'torso', 'chest', 'skin', 'muscular', 'toned', 'chubby', 'fat', 'slim', 'curvy', 'on_back', 'bare_shoulders', 'bare_arms', 'bare_legs', 'bare_feet'] },

  // ---------- 外貌与发型 ----------
  { sub: 'hair', seg: ['hair', 'bangs', 'twin', 'twintails', 'ponytail', 'braid', 'braids', 'hime_cut', 'bob_cut', 'pixie_cut', 'ahoge', 'hairband', 'hair_ornament', 'hair_between_eyes', 'sidelocks', 'drill_hair', 'messy_hair', 'wavy_hair', 'curly_hair', 'straight_hair', 'flipped_hair', 'hair_intakes', 'hair_over_one_eye', 'hair_over_eyes', 'hair_pulled_back', 'hair_ribbon', 'hair_bow', 'hair_flower', 'hairclip', 'hairpins', 'hair_bobbles', 'hair_scrunchie', 'hair_tubes', 'multi-tied_hair', 'folded_ponytail', 'short_ponytail', 'side_ponytail', 'front_ponytail', 'high_ponytail', 'low-tied_long_hair', 'wings'] },
  { sub: 'eyes', seg: ['eyes', 'eye', 'pupils', 'eyelashes', 'eyebrows', 'heterochromia', 'heart-shaped_pupils', 'slit_pupils', 'mismatched_pupils', 'empty_eyes', 'glowing_eyes', 'tsurime', 'tareme', 'half-closed_eyes', 'closed_eyes', 'one_eye_closed', 'wide-eyed', 'wink', 'eye_contact', 'eyewear', 'glasses', 'sunglasses', 'monocle', 'hair_over_one_eye'] },
  { sub: 'animal_ear', seg: ['animal_ears', 'cat_ears', 'dog_ears', 'rabbit_ears', 'fox_ears', 'wolf_ears', 'mouse_ears', 'bear_ears', 'horse_ears', 'raccoon_ears', 'squirrel_ears', 'cow_ears', 'sheep_ears', 'tiger_ears', 'lion_ears', 'panda_ears', 'deer_ears', 'fake_animal_ears', 'tail', 'cat_tail', 'dog_tail', 'fox_tail', 'rabbit_tail', 'horse_tail', 'wolf_tail', 'dinosaur_tail', 'multiple_tails', 'tail_ornament', 'tail_ring', 'tail_bow', 'kemonomimi_mode'] },
  { sub: 'wing_horn', seg: ['wings', 'horns', 'horn', 'demon_horns', 'dragon_horns', 'single_horn', 'black_wings', 'white_wings', 'feathered_wings', 'butterfly_wings', 'wings_of_fire', 'halo', 'head_wings', 'pointy_ears', 'elf_ears', 'fangs', 'claws', 'tentacle_hair'] },
  { sub: 'face', seg: ['face', 'forehead', 'cheeks', 'cheek', 'nose', 'freckles', 'mole', 'mole_under_eye', 'beauty_mark', 'eyepatch', 'bandaid_on_face', 'scar', 'scar_on_face', 'blush', 'light_blush', 'heavy_blush', 'shaded_face'] },

  // ---------- 表情与视线 ----------
  { sub: 'mouth', seg: ['mouth', 'open_mouth', 'closed_mouth', 'tongue', 'tongue_out', 'teeth', 'fangs', 'lipstick', 'lips', 'slavering', 'drooling', 'saliva', 'licking', 'licking_lips', 'biting', 'biting_lip', 'grin', 'teeth_clenched'] },
  { sub: 'expression', seg: ['smile', 'grin', 'frown', 'angry', 'anger', 'sad', 'sadness', 'crying', 'tears', 'teary', 'tears_of_joy', 'surprised', 'surprise', 'shocked', 'embarrassed', 'pout', 'pouting', 'scared', 'fear', 'disgust', 'confused', 'serious', 'expressionless', 'smirk', 'laughing', 'giggle', 'sleepy', 'tired', 'exhausted', 'pain', 'pleasure', 'painful_smile', 'forced_smile', 'wavy_mouth', 'sigh', 'yawning', 'nosebleed', 'sweatdrop', 'sweat', 'sparkle', 'stare', 'glaring', 'shouting', 'screaming', 'smug', 'kubrick_stare'] },
  { sub: 'gaze', seg: ['looking_at_viewer', 'looking_back', 'looking_down', 'looking_up', 'looking_away', 'looking_to_the_side', 'looking_at_another', 'looking_through_legs', 'looking_ahead', 'eye_contact', 'head_tilt', 'facing_viewer', 'facing_away'] },

  // ---------- 服饰与穿戴 ----------
  { sub: 'legwear', seg: ['thighhighs', 'pantyhose', 'socks', 'sock', 'stockings', 'leggings', 'legwear', 'garter_belt', 'garters', 'garter_straps', 'kneehighs', 'tabi', 'fishnet_legwear', 'fishnet_stockings', 'see-through_legwear', 'white_legwear', 'black_legwear', 'torn_legwear', 'footless_legwear', 'leg_ribbon', 'anklet', 'anklets', 'bare_legs'] },
  { sub: 'footwear', seg: ['shoes', 'shoe', 'boots', 'boot', 'sandal', 'sandals', 'heels', 'high_heels', 'sneakers', 'loafers', 'slippers', 'geta', 'platform_footwear', 'mary_janes', 'flip-flops', 'ballet_slippers', 'uwabaki'] },
  { sub: 'headwear', seg: ['hat', 'hats', 'cap', 'beret', 'helmet', 'hood', 'headband', 'crown', 'tiara', 'veil', 'wimple', 'hijab', 'bowler_hat', 'top_hat', 'witch_hat', 'santa_hat', 'miner\'s_hat', 'nurse_cap', 'maid_headdress', 'headdress', 'headpiece', 'headphones', 'hairband'] },
  { sub: 'handwear', seg: ['gloves', 'glove', 'mittens', 'fingerless_gloves', 'elbow_gloves', 'wrist_cuffs', 'nail_polish'] },
  { sub: 'innerwear', seg: ['underwear', 'panties', 'bra', 'lingerie', 'boxer_briefs', 'briefs', 'thong', 'g-string', 'camisole', 'slip_(clothing)', 'corset', 'girdle', 'bloomers', 'pettipants'] },
  { sub: 'swimwear', seg: ['swimsuit', 'bikini', 'one-piece_swimsuit', 'school_swimsuit', 'competition_swimsuit', 'sports_bikini', 'micro_bikini', 'string_bikini', 'tankini', 'monokini', 'swim_briefs', 'board_shorts', 'rash_guard', 'wetsuit', 'sarong'] },
  { sub: 'uniform', seg: ['uniform', 'serafuku', 'sailor_school_uniform', 'blazer_school_uniform', 'suit', 'business_suit', 'tuxedo', 'kimono', 'yukata', 'hakama', 'cheongsam', 'qipao', 'hanfu', 'hanbok', 'sari', 'dirndl', 'nurse_uniform', 'maid_uniform', 'military_uniform', 'police_uniform', 'firefighter_uniform', 'jumpsuit', 'coveralls', 'labcoat', 'lab_coat', 'gym_uniform', 'track_suit', 'baseball_uniform', 'soccer_uniform', 'basketball_uniform', 'sportswear', 'judogi', 'karate_gi', 'kendo_gi', 'wedding_dress', 'bridal_veil', 'toga', 'miko_outfit', 'nun_habit'] },
  { sub: 'clothes_top', seg: ['shirt', 'blouse', 't-shirt', 'tshirt', 'sweater', 'hoodie', 'jacket', 'coat', 'vest', 'cardigan', 'tank_top', 'camisole_top', 'tube_top', 'crop_top', 'bras', 'sports_bra', 'sweatshirt', 'polo_shirt', 'turtleneck', 'dress_shirt', 'shrug', 'poncho', 'cape', 'cloak', 'mantle', 'blazer', 'suit_jacket', 'overalls', 'apron', 'leotard', 'bodysuit', 'corset_top', 'tunic', 'sweater_vest', 'windbreaker', 'parka', 'down_jacket', 'peacoat', 'trench_coat', 'fur_coat', 'kimono_top', 'sarashi', 'bandaged_arm', 'bandages'] },
  { sub: 'clothes_bottom', seg: ['skirt', 'pleated_skirt', 'miniskirt', 'long_skirt', 'pencil_skirt', 'tiered_skirt', 'pants', 'jeans', 'shorts', 'denim_shorts', 'hot_pants', 'harem_pants', 'capri_pants', 'cargo_pants', 'sweatpants', 'trousers', 'bloomers_bottom', 'sarong_bottom', 'hakama_bottom', 'zouri'] },
  { sub: 'clothes_full', seg: ['dress', 'gown', 'sundress', 'evening_gown', 'cocktail_dress', 'sailor_dress', 'wedding_dress', 'summer_dress', 'sweater_dress', 'pinafore', 'jumper_dress', 'furisode', 'robe', 'bathrobe', 'nightgown', 'pajamas', 'sleepwear', 'nightwear', 'tracksuit', 'overall_dress', 'kigurumi', 'santa_costume', 'cosplay_costume'] },
  { sub: 'accessory', seg: ['ribbon', 'bow', 'bowtie', 'necktie', 'tie', 'scarf', 'muffler', 'neckerchief', 'bandana', 'belt', 'sash', 'suspenders', 'brooch', 'badge', 'medal', 'pin', 'earrings', 'earring', 'piercing', 'necklace', 'pendant', 'choker', 'bracelet', 'bangle', 'ring', 'jewelry', 'watch', 'wristwatch', 'purse', 'handbag', 'bag', 'backpack', 'satchel', 'umbrella', 'parasol', 'fan', 'folding_fan', 'hand_fan', 'glasses_chain', 'lanyard', 'keychain', 'plush'] },
  { sub: 'pattern', seg: ['print', 'pattern', 'stripes', 'striped', 'plaid', 'checkered', 'polka_dot', 'argyle', 'floral', 'camo', 'camouflage', 'leopard', 'zebra', 'torn', 'frilled', 'frills', 'lace', 'ruffles', 'pleats', 'pleated', 'detached_sleeves', 'long_sleeves', 'short_sleeves', 'sleeveless', 'puffy_sleeves', 'bell_sleeves', 'fur-trimmed', 'fur_trim', 'epaulettes', 'buttons', 'zipper', 'pockets', 'ribbed'] },

  // ---------- 动作与姿势 ----------
  { sub: 'posture', seg: ['standing', 'sitting', 'lying', 'kneeling', 'crouching', 'squatting', 'on_stomach', 'on_side', 'wariza', 'seiza', 'indian_style', 'legs_together', 'legs_apart', 'crossed_legs', 'crossed_arms', 'arms_behind_head', 'arms_behind_back', 'leaning_forward', 'leaning_back', 'bent_over', 'arched_back', 'stretching', 'tiptoes', 'on_floor', 'on_bed', 'on_chair', 'hugging_legs', 'fetal_position', 'contrapposto', 'unconventional_poses', 'impossible_pose'] },
  { sub: 'hand_action', seg: ['hand_on_hip', 'hands_on_hips', 'hand_on_own_face', 'hand_on_another\'s_face', 'hand_on_own_chest', 'hand_on_own_thigh', 'hand_up', 'hand_up_own_skirt', 'hand_between_legs', 'arms_up', 'arm_up', 'outstretched_arm', 'outstretched_arms', 'reaching', 'reaching_towards_viewer', 'pointing', 'pointing_at_viewer', 'pointing_up', 'waving', 'salute', 'thumbs_up', 'peace_sign', 'v_sign', 'heart_hands', 'middle_finger', 'clenched_hand', 'fist', 'covering_mouth', 'covering_face', 'covering_eyes', 'covering_ears', 'covering_own_mouth', 'facepalm', 'pinching', 'grabbing', 'hugging', 'self_hug', 'arms_crossed', 'hands_up', 'holding_hands', 'interlocked_fingers', 'pinky_swear', 'sleeves_past_fingers', 'sleeves_past_wrists', 'arm_behind_back', 'arms_at_sides', 'arm_support'] },
  { sub: 'leg_action', seg: ['knees_up', 'legs_up', 'one_leg_up', 'leg_lift', 'legs_behind_head', 'foot_up', 'feet_up', 'tiptoes_leg', 'spread_legs', 'legs_crossed_ankles', 'straddling'] },
  { sub: 'action', seg: ['running', 'walking', 'jumping', 'dancing', 'singing', 'eating', 'drinking', 'sleeping', 'reading', 'writing', 'drawing', 'studying', 'playing', 'fighting', 'training', 'exercising', 'swimming', 'flying', 'falling', 'floating', 'riding', 'driving', 'cooking', 'bathing', 'showering', 'dressing', 'undressing_action', 'waking_up', 'stretching_action', 'yoga', 'meditating', 'praying', 'bowing', 'waving_hand', 'clapping', 'playing_instrument', 'playing_games', 'playing_sports', 'watching', 'taking_photo', 'selfie', 'posing', 'attacking', 'charging', 'casting_spell', 'wielding', 'aiming', 'shooting', 'throwing', 'catching', 'swinging', 'striking', 'blocking', 'hiding', 'peeking', 'spying', 'glancing'] },

  // ---------- 场景与背景 ----------
  { sub: 'background', seg: ['background', 'backdrop'] },
  { sub: 'sky_time', seg: ['sky', 'clouds', 'cloudy', 'sun', 'sunlight', 'sunset', 'sunrise', 'dusk', 'dawn', 'twilight', 'night', 'night_sky', 'starry_sky', 'stars', 'star', 'moon', 'full_moon', 'crescent_moon', 'milky_way', 'aurora', 'rainbow', 'blue_sky', 'day', 'daytime', 'morning', 'evening', 'afternoon', 'golden_hour', 'time_of_day'] },
  { sub: 'weather', seg: ['rain', 'raining', 'rainy', 'snow', 'snowing', 'snowy', 'fog', 'foggy', 'mist', 'wind', 'windy', 'storm', 'thunder', 'lightning', 'foggy_window', 'autumn', 'autumn_leaves', 'spring', 'summer', 'winter', 'season', 'sakura', 'cherry_blossoms', 'falling_petals', 'wet', 'puddle'] },
  { sub: 'outdoor', seg: ['outdoors', 'beach', 'ocean', 'sea', 'underwater', 'lake', 'river', 'waterfall', 'forest', 'woods', 'tree', 'trees', 'grass', 'grassland', 'field', 'mountain', 'mountains', 'hill', 'hills', 'desert', 'island', 'swamp', 'cave', 'cliff', 'shore', 'coast', 'shoreline', 'pond', 'garden', 'park', 'flower_field', 'rice_paddy', 'countryside', 'jungle', 'savanna', 'tundra', 'glacier', 'volcano'] },
  { sub: 'city', seg: ['city', 'cityscape', 'town', 'street', 'road', 'alley', 'alleyway', 'sidewalk', 'crosswalk', 'downtown', 'market', 'marketplace', 'shop', 'storefront', 'cafe', 'restaurant', 'bar', 'building', 'buildings', 'skyscraper', 'house', 'village', 'castle', 'ruins', 'temple', 'shrine', 'church', 'cathedral', 'bridge', 'tower', 'stairs', 'staircase', 'balcony', 'rooftop', 'roof', 'fence', 'wall', 'gate', 'lamppost', 'streetlight', 'traffic_light', 'sign', 'signage', 'billboard', 'neon_lights', 'utility_pole', 'power_lines', 'train_station', 'platform', 'airport', 'harbor', 'dock', 'pier'] },
  { sub: 'indoor', seg: ['indoors', 'room', 'bedroom', 'living_room', 'kitchen', 'bathroom', 'classroom', 'school', 'library', 'office', 'hallway', 'corridor', 'attic', 'basement', 'closet', 'wardrobe', 'cellar', 'laboratory', 'hospital', 'gym', 'gymnasium', 'auditorium', 'theater', 'cinema', 'museum', 'hotel', 'inn', 'cafe_interior', 'restaurant_interior', 'store_interior', 'train_interior', 'car_interior', 'cockpit', 'elevator', 'greenhouse', 'cage', 'dungeon', 'throne_room', 'control_room', 'server_room', 'sauna', 'onsen', 'bath', 'bathtub', 'shower', 'toilet', 'window', 'curtains', 'door', 'doorway', 'mirror', 'ceiling', 'floor'] },

  // ---------- 物件与道具 ----------
  { sub: 'weapon', seg: ['sword', 'katana', 'blade', 'dagger', 'knife', 'spear', 'lance', 'axe', 'hammer', 'mace', 'bow_(weapon)', 'arrow', 'arrows', 'crossbow', 'gun', 'pistol', 'rifle', 'shotgun', 'machine_gun', 'cannon', 'bazooka', 'missile', 'grenade', 'bomb', 'shield', 'armor', 'armour', 'helmet_armor', 'staff', 'wand', 'scepter', 'scythe', 'whip', 'chain', 'chains', 'shuriken', 'kunai', 'naginata', 'halberd', 'rapier', 'scabbard', 'sheath', 'holster', 'ammunition', 'bullet', 'bullets', 'grenade_launcher', 'rocket_launcher', 'laser', 'beam_saber', 'lightsaber'] },
  { sub: 'food', seg: ['food', 'drink', 'drinks', 'eating_food', 'cake', 'cupcake', 'cookie', 'cookies', 'bread', 'toast', 'sandwich', 'burger', 'hamburger', 'pizza', 'pasta', 'noodles', 'ramen', 'rice', 'onigiri', 'sushi', 'bento', 'ice_cream', 'icecream', 'chocolate', 'candy', 'lollipop', 'pocky', 'donut', 'doughnut', 'pie', 'tart', 'pudding', 'jelly', 'pancake', 'waffle', 'crepe', 'macaron', 'mochi', 'dango', 'tea', 'coffee', 'milkshake', 'juice', 'soda', 'beer', 'wine', 'champagne', 'sake', 'cocktail', 'bubble_tea', 'milk', 'water_bottle', 'bottle', 'can', 'cup', 'mug', 'glass', 'teacup', 'teapot', 'plate', 'bowl', 'chopsticks', 'fork', 'spoon', 'tray', 'straw', 'apple', 'banana', 'orange_fruit', 'strawberry', 'cherry', 'cherries', 'grapes', 'watermelon', 'peach', 'pear', 'lemon', 'lime', 'pineapple', 'mango', 'coconut', 'kiwi', 'blueberry', 'raspberry', 'berries', 'fruit', 'vegetables', 'tomato', 'carrot', 'corn', 'potato', 'onion', 'mushroom', 'egg', 'eggs', 'cheese', 'sausage', 'meat', 'fish', 'seafood', 'shrimp', 'octopus', 'crab', 'squid', 'tako'] },
  { sub: 'plant', seg: ['flower', 'flowers', 'rose', 'roses', 'sunflower', 'tulip', 'lily', 'orchid', 'lotus', 'daisy', 'hibiscus', 'hydrangea', 'morning_glory', 'wisteria', 'violet', 'pansy', 'carnation', 'chrysanthemum', 'peony', 'plum_blossoms', 'flower_petals', 'petals', 'leaf', 'leaves', 'branch', 'branches', 'bush', 'vine', 'vines', 'ivy', 'moss', 'fern', 'cactus', 'succulent', 'potted_plant', 'houseplant', 'bouquet', 'wreath', 'garland', 'flower_crown', 'vase'] },
  { sub: 'animal', seg: ['cat', 'cats', 'kitten', 'dog', 'dogs', 'puppy', 'bird', 'birds', 'rabbit', 'bunny', 'hamster', 'mouse', 'rat', 'squirrel', 'fox', 'wolf', 'bear', 'panda', 'tiger', 'lion', 'leopard', 'cheetah', 'horse', 'pony', 'unicorn', 'pegasus', 'cow', 'pig', 'sheep', 'goat', 'deer', 'elephant', 'giraffe', 'zebra', 'monkey', 'gorilla', 'snake', 'lizard', 'frog', 'turtle', 'tortoise', 'dinosaur', 'dragon', 'dragon_girl', 'phoenix', 'butterfly', 'butterflies', 'bee', 'bees', 'spider', 'scorpion', 'ant', 'insect', 'bug', 'fish_animal', 'shark', 'whale', 'dolphin', 'jellyfish', 'starfish', 'seahorse', 'penguin', 'owl', 'eagle', 'hawk', 'crow', 'raven', 'sparrow', 'swan', 'duck', 'chicken', 'rooster', 'parrot', 'flamingo', 'peacock', 'dove', 'bat', 'koala', 'kangaroo', 'sloth', 'otter', 'seal', 'camel', 'llama', 'alpaca', 'moose', 'raccoon', 'hedgehog', 'chameleon', 'crab_animal', 'octopus_animal', 'squid_animal', 'shrimp_animal'] },
  { sub: 'furniture', seg: ['bed', 'chair', 'table', 'desk', 'sofa', 'couch', 'bench', 'stool', 'shelf', 'bookshelf', 'cabinet', 'drawer', 'dresser', 'wardrobe_furniture', 'mirror_furniture', 'lamp', 'chandelier', 'candle', 'candles', 'lantern', 'lamp_post', 'pillow', 'pillows', 'cushion', 'blanket', 'bed_sheet', 'bedding', 'duvet', 'mattress', 'futon', 'carpet', 'rug', 'mat', 'coffee_table', 'nightstand', 'counter', 'countertop', 'cupboard', 'fridge', 'refrigerator', 'oven', 'stove', 'sink', 'microwave', 'kettle', 'pan', 'pot', 'stove_top', 'wardrobe_closet', 'locker', 'coat_rack', 'hanger', 'clothes_rack', 'screen', 'folding_screen', 'partition'] },
  { sub: 'music', seg: ['guitar', 'bass_guitar', 'violin', 'cello', 'piano', 'keyboard_instrument', 'drum', 'drums', 'flute', 'trumpet', 'saxophone', 'harp', 'lyre', 'accordion', 'harmonica', 'tambourine', 'xylophone', 'microphone', 'headphones_audio', 'speaker', 'boombox', 'radio', 'walkman', 'record_player', 'vinyl', 'cassette', 'cd', 'headset', 'earphones', 'instrument'] },
  { sub: 'vehicle', seg: ['car', 'cars', 'automobile', 'truck', 'bus', 'van', 'taxi', 'motorcycle', 'motorbike', 'scooter', 'bicycle', 'bike', 'train', 'trains', 'locomotive', 'subway', 'tram', 'airplane', 'plane', 'aircraft', 'helicopter', 'jet', 'boat', 'ship', 'sailboat', 'yacht', 'canoe', 'kayak', 'raft', 'submarine', 'spaceship', 'rocket', 'spacecraft', 'tank', 'tractor', 'bulldozer', 'ambulance', 'fire_truck', 'police_car', 'wagon', 'cart', 'carriage', 'sled', 'sleigh', 'skateboard', 'roller_skates', 'ice_skates', 'skis', 'snowboard', 'wheelchair'] },
  { sub: 'toy', seg: ['doll', 'dolls', 'plushie', 'stuffed_animal', 'teddy_bear', 'figure', 'figurine', 'action_figure', 'nendoroid', 'lego', 'block', 'blocks', 'puzzle', 'balloon', 'balloons', 'kite', 'top', 'spinning_top', 'marble', 'marble_(toy)', 'toy', 'toys', 'card', 'cards', 'playing_card', 'board_game', 'chess', 'shogi', 'go_(game)', 'dice', 'puppet', 'marionette', 'paper_airplane'] },
  { sub: 'tool', seg: ['book', 'books', 'notebook', 'diary', 'journal', 'magazine', 'newspaper', 'letter', 'envelope', 'paper', 'papers', 'scroll', 'map', 'pencil', 'pen', 'brush', 'paintbrush', 'crayon_tool', 'marker_tool', 'eraser', 'ruler', 'scissors', 'stapler', 'clipboard', 'folder', 'binder', 'backpack_tool', 'toolbox', 'wrench', 'screwdriver', 'hammer_tool', 'saw', 'drill', 'pliers', 'rope', 'chains_tool', 'key', 'keys', 'padlock', 'lock', 'ladder', 'bucket', 'broom', 'mop', 'shovel', 'rake', 'watering_can', 'flashlight', 'match', 'matches', 'lighter', 'paint_can', 'syringe', 'stethoscope', 'scalpel', 'test_tube', 'flask', 'microscope', 'telescope', 'binoculars', 'camera', 'phone', 'smartphone', 'cellphone', 'computer', 'laptop', 'monitor', 'television', 'tv', 'remote_control', 'video_game', 'game_controller', 'arcade_machine', 'clock', 'clocks', 'alarm_clock', 'hourglass', 'compass', 'magnifying_glass', 'trophy', 'medal_trophy', 'flag', 'banner', 'balloon_tool'] },
  { sub: 'media_text', seg: ['text', 'letters', 'word', 'words', 'speech', 'signature', 'logo', 'icon', 'chart', 'graph', 'diagram', 'ui', 'interface', 'screenshot_ui', 'window_(computing)', 'cursor', 'menu', 'button_(ui)'] },

  // ---------- 画师与来源 ----------
  { sub: 'source', seg: ['bad_id_tag', 'artist_name_tag', 'third_party_edit', 'official_art', 'fanart', 'commission', 'commissioned', 'request', 'collab', 'twitter', 'pixiv', 'deviantart', 'tumblr', 'instagram', 'patreon', 'fanbox', 'skeb', 'bilibili', 'weibo', 'douyin', 'youtube', 'nicovideo', 'danbooru', 'gelbooru', 'e-shuushuu', 'zerochan', 'konachan', 'safebooru', 'yande.re', 'anime_picture', 'sankaku', 'pixiv_id', 'source_request', 'reference', 'scanned', 'ai_generated', 'ai-assisted'] },

  // =====================================================================
  // 第二轮补漏：第一版只列了「典型词」，实际标签表里还有大量**通用部位词 / 穿戴词 /
  // 物件词**（`black_footwear` / `detached_collar` / `page_theme` …）没有接住。
  // 这一块是拿 `.workbuddy/tmp/report-other-shape.js` 的词头/词尾分布逐条对出来的，
  // 不是凭印象补的。
  //
  // ⚠️ 这一块放在**最后**：它承接的是「前面都没接住」的词，所以顺序上必须后置。
  //    新增规则时若与上面任何一条语义重叠，应当**改上面那条**，而不是在这里覆盖 ——
  //    否则同一批标签的分类会随「哪条先写」而漂移。
  // =====================================================================

  // 穿戴类补漏
  { sub: 'pattern', seg: ['clothes_lift', 'clothes_pull', 'open_clothes', 'clothing_cutout', 'clothes_removed', 'sleeves', 'trim', 'lace_trim', 'asymmetrical', 'oversized', 'revealing_clothes', 'unbuttoned', 'untied', 'sagging', 'strapless', 'halterneck', 'highleg', 'side_slit', 'pelvic_curtain', 'obi', 'denim', 'leather', 'silky', 'ribbed', 'frilled', 'pleated', 'tucked', 'skindentation'] },
  { sub: 'clothes_full', seg: ['clothes', 'japanese_clothes', 'chinese_clothes', 'costume', 'outfit', 'alternate_costume', 'adapted_costume', 'official_alternate_costume', 'casual', 'formal', 'traditional_clothes', 'santa_costume'] },
  { sub: 'headwear', seg: ['headwear', 'headgear', 'scrunchcie', 'scrunchie', 'mask', 'no_headwear', 'goggles', 'visor'] },
  { sub: 'footwear', seg: ['footwear', 'no_footwear', 'shoes_removed'] },
  { sub: 'accessory', seg: ['collar', 'detached_collar', 'wing_collar', 'ascot', 'cross', 'choker_necklace', 'armband', 'armlet', 'wristband', 'tassel', 'buckle', 'bell', 'gem', 'jingle_bell', 'nose_ring', 'headphones_around_neck'] },
  { sub: 'handwear', seg: ['nails', 'arm_warmers', 'bridal_gauntlets', 'gauntlets', 'fingerless'] },
  { sub: 'clothes_top', seg: ['capelet', 'poncho_cape', 'bolero', 'gilet', 'tankini_top'] },
  { sub: 'clothes_bottom', seg: ['buruma', 'pantsu'] },
  { sub: 'innerwear', seg: ['slip', 'panty', 'pantyshot', 'cameltoe', 'wataboushi'] },

  // 人体类补漏
  { sub: 'body', seg: ['midriff', 'armpits', 'hip', 'pectorals', 'tattoo', 'thigh_strap', 'shoulder_blade', 'hip_bones', 'collarbone_piercing', 'height_difference', 'size_difference', 'groin', 'soles', 'toes', 'carrying'] },
  { sub: 'hair', seg: ['bun', 'double_bun', 'half_updo', 'updo', 'bob_cut', 'alternate_hairstyle', 'hair_flip', 'wavy'] },
  { sub: 'eyes', seg: ['sclera', 'eyelid', 'eyeball', 'glowing_eye'] },
  { sub: 'mouth', seg: ['fang'] },
  { sub: 'animal_ear', seg: ['ears', 'fake_animal_ears', 'animal_ear_fluff', 'multiple_tails', 'feathers'] },
  { sub: 'face', seg: ['facial_mark', 'facial_tattoo', 'beard', 'stubble', 'blemish'] },
  { sub: 'identity', seg: ['military', 'army', 'navy', 'schoolgirl', 'office_worker', 'shopkeeper', 'bartender', 'singer', 'dancer', 'musician', 'artist_person', 'villain', 'hero', 'superhero', 'mob', 'yakuza'] },

  // 场景类补漏
  { sub: 'sky_time', seg: ['cloud', 'horizon', 'sunbeam', 'god_rays', 'sunset_horizon'] },
  { sub: 'weather', seg: ['ice', 'ice_crystals', 'frozen', 'fog_over_water'] },
  { sub: 'outdoor', seg: ['water', 'nature', 'scenery', 'plant', 'ground', 'dirt', 'soil', 'sand', 'rock', 'rocks', 'stone', 'stones', 'boulder', 'earth'] },
  { sub: 'indoor', seg: ['room_interior', 'furnished'] },

  // 物件类补漏
  { sub: 'weapon', seg: ['weapon', 'weapons', 'blunt_weapon', 'polearm', 'handgun', 'rifle_weapon', 'knife_weapon', 'dual_wield'] },
  { sub: 'tool', seg: ['box', 'crate', 'chest', 'basket', 'bag_tool', 'handheld_microphone', 'towel', 'handkerchief', 'napkin', 'coaster', 'placemat', 'doily'] },
  { sub: 'music', seg: ['musical_note', 'notes', 'sheet_music', 'music_notes', 'jingle_bell'] },
  { sub: 'toy', seg: ['ball', 'plush_doll', 'stuffed_toy'] },
  { sub: 'media_text', seg: ['symbol', 'symbols', 'arrow', 'arrows', 'question_mark', 'exclamation_mark', 'heart_symbol', 'speech_bubble_tail', 'sparkle_symbol'] },
  { sub: 'food', seg: ['alcohol', 'liquor', 'snack', 'meal', 'dish', 'plate_of_food'] },

  // 动作类补漏
  { sub: 'action', seg: ['kiss', 'hug', 'grab', 'peek', 'selfie_action', 'photo_with', 'playing_with_hair', 'wading'] },
  { sub: 'posture', seg: ['pose', 'leaning', 'all_fours', 'two_side_up', 'one_side_up', 'barefoot'] },
  { sub: 'hand_action', seg: ['v', 'index_finger_raised', 'covering', 'breast_grab', 'breast_hold', 'breast_press', 'panty_pull', 'breast_press_action'] },

  // 成人类补漏
  { sub: 'sexual', seg: ['vaginal', 'oral', 'erection', 'testicles', 'anal_sex', 'threesome', 'hetero', 'yuri', 'yaoi', 'bara', 'genderswap', 'otoko_no_ko', 'kiss_adult'] },
  { sub: 'censored', seg: ['censoring', 'censor', 'uncensored_version', 'light_bar'] },
  { sub: 'fetish', seg: ['bdsm', 'bound', 'bound_wrists', 'bound_legs', 'suspended'] },

  // 人物类补漏
  { sub: 'count', seg: ['no_humans', 'siblings', 'sisters', 'sisters_pair', 'couple', 'friends', 'duo'] },
  { sub: 'age', seg: ['younger', 'older', 'loli', 'shota'] },

  // 构图与画质补漏
  { sub: 'framing', seg: ['focus', 'depth_of_field', 'shallow_depth_of_field', 'blurry_background', 'motion_blur', 'motion_lines', 'foreshortening', 'shadow', 'light_particles', 'lens_flare', 'steam', 'breath', 'glowing', 'cross-layered'] },
  { sub: 'angle', seg: ['pov', 'reverse_pov'] },
  { sub: 'quality', seg: ['jpeg_artifacts', 'dated', 'scan', 'game_cg', 'traditional_media'] },
  { sub: 'medium', seg: ['official', 'authentic'] },

  // 主题与来源补漏
  { sub: 'holiday', seg: ['theme', 'anniversary', 'celebration'] },
  { sub: 'source', seg: ['character_name', 'copyright_name', 'parody', 'crossover', 'personification', 'official_art_source', 'multiple_drawn'] },

  // =====================================================================
  // 第三轮：**作品名清单 + 画风/场景/物件补漏 + 题材设定**。
  //
  // 这一轮的依据与前两轮不同：前两轮是看「词形分布」猜该补哪一类，
  // 这一轮是**把导航页真正会显示的那 1752 个标签（真库索引里已出现的）逐条过了一遍**，
  // 对其中落进 `other` 的 337 条逐条分类得到的（`.workbuddy/tmp/other-visible.txt`）。
  // 逐条看是必要的：作品名与角色名从词形上完全看不出区别
  // （`touhou` 与 `cirno` 都是小写单词）。
  //
  // ⚠️ SERIES 清单**只列作品/系列本身**，角色名**不要**写进来 ——
  //    角色的判据是「段里含 SERIES 名」「是 `name_(作品)` 形态」或「段里含常见人名」，
  //    混在一起会让「作品 vs 角色」这一级导航失去意义。
  // =====================================================================

  // ---- 作品 / 系列（franchise 本身）----
  {
    sub: 'series',
    seg: [
      'touhou', 'kantai_collection', 'idolmaster', 'pokemon', 'vocaloid', 'virtual_youtuber', 'nijisanji',
      'hololive', 'azur_lane', 'arknights', 'precure', 'final_fantasy', 'gundam', 'mahou_shoujo_madoka_magica',
      'girls_und_panzer', 'genshin_impact', 'love_live!', 'fire_emblem', 'girls\'_frontline', 'jojo_no_kimyou_na_bouken',
      'granblue_fantasy', 'k-on!', 'lyrical_nanoha', 'persona', 'world_witches_series', 'suzumiya_haruhi_no_yuuutsu',
      'suzumiya_haruhi', 'fate/grand_order', 'fate/extra', 'fate/apocrypha', 'fate/zero', 'fate/extra_ccc',
      'fate/kaleid_liner_prisma_illya', 'fate_testarossa', 'toaru_majutsu_no_index', 'toaru_kagaku_no_railgun',
      'umamusume', 'strike_witches', 'idolmaster_cinderella_girls', 'idolmaster_shiny_colors', 'idolmaster_million_live!',
      'idolmaster_cinderella_girls_starlight_stage', 'touken_ranbu', 'hololive_english', 'love_live!_sunshine!!',
      'the_legend_of_zelda', 'league_of_legends', 'kill_la_kill', 'overwatch', 're:zero_kara_hajimeru_isekai_seikatsu',
      'fire_emblem:_three_houses', 'yu-gi-oh!', 'mahou_shoujo_lyrical_nanoha', 'mahou_shoujo_lyrical_nanoha_strikers',
      'mahou_shoujo_lyrical_nanoha_a\'s', 'code_geass', 'gochuumon_wa_usagi_desu_ka?', 'blazblue', 'guilty_gear',
      'fire_emblem_heroes', 'fire_emblem_fates', 'fire_emblem_awakening', 'umineko_no_naku_koro_ni',
      'final_fantasy_vii', 'final_fantasy_xiv', 'final_fantasy_x', 'tengen_toppa_gurren_lagann', 'pokemon_bw',
      'pokemon_bw2', 'pokemon_dppt', 'pokemon_hgss', 'pokemon_xy', 'pokemon_sm', 'pokemon_swsh',
      'rozen_maiden', 'ragnarok_online', 'honkai_impact_3rd', 'one_piece', 'higurashi_no_naku_koro_ni',
      'kono_subarashii_sekai_ni_shukufuku_wo!', 'rebuild_of_evangelion', 'macross', 'macross_frontier',
      'shingeki_no_kyojin', 'blue_archive', 'danganronpa_2:_goodbye_despair', 'danganronpa_v3:_killing_harmony',
      'danganronpa:_trigger_happy_havoc', 'xenoblade_chronicles_2', 'naruto', 'rwby', 'tsukihime',
      'senki_zesshou_symphogear', 'nier_automata', 'super_smash_bros.', 'inazuma_eleven_go', 'to_heart', 'to_heart_2',
      'bakemonogatari', 'kamen_rider', 'tokyo_afterschool_summoners', 'kimetsu_no_yaiba', 'senran_kagura',
      'splatoon_1', 'bleach', 'go-toubun_no_hanayome', 'gundam_00', 'gundam_seed', 'little_busters!',
      'dokidoki!_precure', 'heartcatch_precure!', 'axis_powers_hetalia', 'clannad', 'warship_girls_r', 'to_love-ru',
      'marvel', 'dc_comics', 'new_super_mario_bros._u_deluxe', 'mahou_shoujo_madoka_magica_movie',
      'darling_in_the_franxx', 'elsword', 'gridman_universe', 'dead_or_alive', 'nitroplus', 'saki', 'sakura_wars',
      'fullmetal_alchemist', 'digimon', 'resident_evil', 'tekken', 'snk', 'transformers', 'fatal_fury',
      'ace_attorney', 'mario', 'nintendo', 'capcom', 'disney', 'kanon', 'yotsubato!', 'ikkitousen', 'azumanga_daioh',
      'mabinogi', 'warcraft', 'gensou_suikoden', 'os-tan', 'bang_dream!', 'hypnosis_mic', 'touhou_project',
      'street_fighter', 'king_of_fighters', 'soulcalibur', 'metroid', 'kirby', 'sonic_the_hedgehog', 'final_fantasy_ix',
      'dragon_quest', 'tales_of', 'atelier', 'dynasty_warriors', 'samurai_warriors', 'devil_may_cry', 'bayonetta',
      'splatoon', 'splatoon_2', 'animal_crossing', 'fire_emblem_gaiden', 'the_idolmaster', 'kancolle', 'kanpani',
    ],
  },

  // ---- 题材与设定（trope）----
  {
    sub: 'trope',
    seg: [
      'transformation', 'personification', 'animalization', 'genderswap', 'crossover', 'parody', 'meme',
      'science_fiction', 'fantasy', 'monster', 'creature', 'furry', 'mermaid', 'skeleton', 'oni', 'jiangshi',
      'real_life', 'real_life_insert', 'os-tan', 'borrowed_character', 'multiple_persona', 'dual_persona',
      'dark_persona', 'multiple_others', 'take_your_pick', 'namesake', 'age_difference', 'reverse_trap',
      'kemonomimi', 'mixed-race', 'fictional_language', 'occult', 'religion', 'mythology', 'folklore',
    ],
  },

  // ---- 画风 / 画质 / 语言与呈现 ----
  // 🔴 这里**刻意没有** `indian_style`：它后缀虽像画风，实际是**盘腿坐**
  //    （Danbooru 上 implicates `sitting`、Tag group = Posture）⇒ 归 `pose/posture`。
  //    2026-10-09 修正 —— 原先生在本规则里，是被 `_style` 后缀误导收进来的。
  //    往这条规则加词前先确认「它真的是画风/技法」，别重蹈覆辙。
  {
    sub: 'medium',
    seg: [
      'retro_artstyle', 'contemporary', 'photo-referenced', 'cosplay_photo', 'concept_art',
      'graffiti', 'screencap', 'image_sample', 'sample', 'dougi', 'screencap_medium', 'reference_sheet',
    ],
  },
  { sub: 'quality', seg: ['resized', 'tall_image', 'wide_image', 'film_grain', 'camera', 'depth', 'caustics'] },
  { sub: 'palette', seg: ['gothic', 'egyptian', 'darkness', 'soap_bubbles', 'soap', 'bokeh'] },
  { sub: 'render', seg: ['kerchief', 'fashion', 'makeup_style'] },

  // ---- 场景 / 建筑 / 家具补漏 ----
  {
    sub: 'indoor',
    seg: [
      'tatami', 'tiles', 'sliding_doors', 'walk-in', 'throne', 'armchair', 'chalkboard', 'railing', 'stair',
      'counter_interior', 'pool', 'poolside', 'bathroom_stall', 'stall', 'booth',
    ],
  },
  { sub: 'city', seg: ['statue', 'pillar', 'architecture', 'east_asian_architecture', 'building_exterior', 'torii_gate'] },
  { sub: 'sky_time', seg: ['moonlight', 'crescent', 'planet', 'space', 'lights', 'light_bulb', 'light_rays', 'glint', 'backlighting'] },
  { sub: 'outdoor', seg: ['wilderness', 'underwater_surface', 'submerged', 'partially_submerged', 'soap_bubbles_scene'] },

  // ---- 物件补漏 ----
  { sub: 'tool', seg: ['spatula', 'toothbrush', 'stylus', 'controller', 'cable', 'pipe', 'saucer', 'cowbell', 'pouch', 'sack', 'pocket', 'tape', 'lotion', 'money', 'coin', 'pointer', 'picture_frame', 'faucet', 'cigarette', 'cigar', 'watercraft', 'motor_vehicle', 'machinery', 'warship', 'torpedo', 'turret', 'anchor', 'skates', 'pumps'] },
  { sub: 'media_text', seg: ['heart', 'emblem', 'sound_effects', 'image_macro', 'product_placement', 'name_tag', 'copyright', 'profanity', 'what', 'error', 'truth', 'sparkle_symbol', 'pentagram', 'hexagram', 'pentacle', 'skull_and_crossbones', 'mask_symbol', 'question'] },
  { sub: 'plant', seg: ['bloom', 'bamboo', 'antlers_branch', 'wreath_plant'] },
  { sub: 'animal', seg: ['goldfish', 'creature_animal', 'monster_animal', 'insect_wings'] },
  { sub: 'furniture', seg: ['armchair_furniture', 'kotatsu', 'throne_furniture', 'counter_top'] },
  { sub: 'weapon', seg: ['harness', 'armor_piece'] },
  { sub: 'toy', seg: ['statue_toy', 'figure_toy'] },

  // ---- 服饰补漏 ----
  {
    sub: 'clothes_full',
    seg: [
      'shawl', 'chemise', 'negligee', 'babydoll', 'bodystocking', 'bustier', 'bandeau', 'loincloth', 'fundoshi',
      'spandex', 'latex_clothing', 'harness_clothing', 'chaps', 'tabard', 'haori', 'kariginu', 'gakuran',
      'cloth_wrapping', 'towel_wrap', 'bath_towel', 'swaddle',
    ],
  },
  { sub: 'headwear', seg: ['beanie', 'bonnet', 'circlet', 'diadem', 'earmuffs', 'hachimaki', 'topknot', 'afro', 'head_fins', 'antennae'] },
  { sub: 'accessory', seg: ['beads', 'wedding_band', 'o-ring', 'multiple_rings', 'necklace_ring', 'brooch_accessory', 'garter'] },
  { sub: 'legwear', seg: ['single_thighhigh', 'over-kneehighs', 'single_kneehigh', 'fishnets', 'garter_straps_legwear', 'hose'] },
  { sub: 'innerwear', seg: ['pasties', 'maebari', 'gusset', 'under_covers', 'crotchless', 'crotchless_panties', 'lowleg'] },
  { sub: 'clothes_top', seg: ['v-neck', 'waistcoat_top', 'undershirt_top'] },
  { sub: 'pattern', seg: ['spaghetti_strap', 'strap_gap', 'strap', 'straps', 'unzipped', 'partially_unzipped', 'pulled_by_self', 'clothing_aside', 'patterned_clothing', 'center_opening', 'zettai_ryouiki', 'tight', 'single_vertical_stripe', 'multiple_rings_pattern'] },

  // ---- 表情 / 视线补漏 ----
  { sub: 'expression', seg: ['happy', 'shy', 'annoyed', 'nervous', 'trembling', 'wince', 'moaning', 'thinking', 'shushing', 'raised_eyebrow', 'staring', 'ahegao', 'torogao', 'jitome', 'faceless', 'death', 'glint_expression', 'smug_face'] },
  { sub: 'gaze', seg: ['facing_another', 'sideways_glance', 'looking_afar', 'top-down_bottom-up', 'upside-down', 'perspective'] },
  { sub: 'face', seg: ['makeup', 'eyeshadow', 'eyeliner', 'mascara', 'facepaint', 'bodypaint', 'cosmetics', 'red_eyeshadow', 'sideburns', 'mustache', 'goatee', 'whisker_markings', 'dimples_of_venus', 'cleft_of_venus', 'bruise', 'injury', 'stitches', 'scar', 'bandaid', 'veins', 'nape', 'plump', 'petite', 'skinny', 'tomboy', 'manly', 'biceps', 'belly', 'big_belly', 'ribs', 'backboob', 'armpit_crease', 'kneepits', 'pregnant', 'flexible', 'hairy', 'bald', 'albino', 'ambiguous_gender'] },

  // ---- 动作 / 姿势补漏 ----
  { sub: 'posture', seg: ['head_rest', 'breast_rest', 'breast_lift', 'breast_suppress', 'reclining', 'folded', 'sheathed', 'stretch', 'split', 'exercise', 'yokozuwari', 'pigeon-toed', 'one-eyed', 'reclining_pose', 'lying_on_stomach', 'sitting_on_lap', 'upright_straddle', 'straddle', 'presenting', 'kneeling_pose'] },
  { sub: 'action', seg: ['talking', 'kicking', 'punching', 'groping', 'splashing', 'dripping', 'pulling', 'lifting_person', 'lifted_by_self', 'lifted_by_another', 'shushing_action', 'peeing', 'pee', 'flashing', 'walk-in', 'come_hither', 'strangling', 'asphyxiation', 'suspension', 'wedgie', 'flexing'] },
  { sub: 'hand_action', seg: ['pinky_out', 'toe_scrunch', 'palms', 'pulling_own_clothes', 'hand_on_another'] },

  // ---- 成人内容补漏 ----
  {
    sub: 'sexual',
    seg: [
      'facial', 'cumdrip', 'condom', 'used_condom', 'condom_wrapper', 'cowgirl_position', 'reverse_cowgirl_position',
      'doggystyle', 'missionary', 'femdom', 'dominatrix', 'interracial', 'incest', 'bukkake', 'clitoris', 'labia',
      'urethra', 'foreskin', 'flaccid', 'nipple_tweak', 'nipple_rings', 'object_insertion', 'fingering',
      'cunnilingus', 'deepthroat', 'gaping', 'bestiality', 'suggestive_fluid', 'partially_visible_vulva',
      'one_breast_out', 'breast_sucking', 'breast_squeeze', 'self_fondle', 'gangbang', 'peeing_adult',
      'public_indecency', 'exhibitionism', 'squirting', 'vibrator_adult',
    ],
  },
  { sub: 'fetish', seg: ['restrained', 'handcuffs', 'shackles', 'gagged', 'suspension_fetish', 'body_paint_fetish', 'monster_adult'] },
  { sub: 'nudity', seg: ['underbust', 'maebari_nudity', 'nipple_hair'] },

  // ---- 画师 / 角色（最后才判，避免抢走内容词）----
  { sub: 'character', seg: ['hatsune_miku', 'kagamine_rin', 'kagamine_len', 'megurine_luka', 'meiko', 'kaito', 'gumi'] },

  // =====================================================================
  // 第四轮：把「可见集合里剩下的最后 42 条」逐条收掉。
  //
  // 截至这一轮前，可见集合（索引里已出现的 1752 个标签）还剩 42 条落 `other`，
  // 它们每一类都只出现一两次，所以**不适合再抽通用 token** ——
  // 逐条点名比抽 token 更安全（抽 token 会波及别处，点名只影响这一条）。
  // 这也是 `full` / OVERRIDES 存在的意义：例外应当显式，而不是被通配规则悄悄吸收。
  // =====================================================================
  { sub: 'cosplay', seg: ['cosplay'] },
  { sub: 'element', seg: ['fire', 'flame', 'smoke', 'bubble', 'air_bubble', 'ripples', 'reflection', 'silhouette', 'transparent', 'x-ray', 'magic_circle', 'scales', 'snowflakes', 'electricity', 'dark', 'light', 'sparkle', 'caustics_element'] },
  { sub: 'source', seg: ['third-party_edit', 'third_party_edit'] },
  { sub: 'tool', seg: ['innertube', 'in_container'] },
  { sub: 'trope', seg: ['crossdressing', 'cowboy_western'] },
  { sub: 'count', seg: ['1other', 'multiple_others_count'] },
  { sub: 'action', seg: ['smoking', 'object_on_head'] },
  { sub: 'body', seg: ['disembodied_limb'] },
  { sub: 'gaze', seg: ['face-to-face'] },
  { sub: 'posture', seg: ['plantar_flexion'] },
  { sub: 'handwear', seg: ['toenail_polish'] },
  { sub: 'character', seg: ['souryuu_asuka_langley', 'tifa_lockhart', 'chun-li', 'asahina_mikuru', 'ikari_shinji', 'cammy_white', 'yohane', 'takarada_rikka', 'lyrica_prismriver', 'ito_noizi'] },
  { sub: 'emoticon', full: ['\\m/', 'xd', 'zzz'] },
  { sub: 'animal', seg: ['animal'] },
  { sub: 'media_text', seg: ['skull'] },
  { sub: 'quality', seg: ['dirty'] },

  // ---- 「手持」兜底 ----
  // 🔴 `holding_*` **刻意放在最后**：由**被持有的那个名词**决定分类
  //    （`holding_sword`→武器、`holding_cake`→食物、`holding_book`→器物）。
  //    第一版把 `holding` 放在动作块里 ⇒ 它在「武器」之前命中，于是 67 个
  //    `holding_*` 全被抢到「手部动作」，武器/食物节点因此显得很空
  //    （守护的定点断言 `holding_sword → weapon` 直接把它抓了出来）。
  //    这一条只兜住「持有物不在任何规则里」的情形，属于**真正的动作**语义。
  { sub: 'hand_action', seg: ['holding'] },

  // ---- 身份/职业**必须放在最后** ----
  // 🔴 这些词经常是服饰标签的**前缀**（`witch_hat` / `maid_uniform` / `nurse_cap` /
  //    `sailor_collar` / `police_uniform` / `military_uniform`）。第一版把 identity 放在
  //    服饰之前 ⇒ 这些标签全被抢成「身份与职业」，服饰节点因此少掉一大批。
  //    身份词本身是**开放**的（什么职业都可能出现），而服饰词的判据更具体 —— 按
  //    「先具体后宽泛」的纪律，具体的服饰先判。
  { sub: 'identity', seg: ['student', 'teacher', 'nurse', 'doctor', 'maid', 'police', 'officer', 'soldier', 'knight', 'princess', 'prince', 'queen', 'king', 'witch', 'wizard', 'mage', 'priest', 'priestess', 'miko', 'nun', 'idol', 'model', 'athlete', 'cheerleader', 'waitress', 'waitstaff', 'cook', 'chef', 'baker', 'scientist', 'engineer', 'detective', 'thief', 'ninja', 'samurai', 'pirate', 'captain', 'pilot', 'diver', 'astronaut', 'office_lady', 'businessman', 'secretary', 'librarian', 'babysitter', 'gardener', 'farmer', 'hunter', 'ranger', 'bodyguard', 'assassin', 'demon', 'angel', 'devil', 'fairy', 'elf', 'dwarf', 'orc', 'vampire', 'zombie', 'ghost', 'yokai', 'god', 'goddess', 'deity', 'spirit', 'robot', 'android', 'cyborg', 'mecha', 'slime'] },
];

/**
 * 整条标签相等的**最高优先级覆盖**（在 RULES 之前判）。
 *
 * 用途只有一个：某标签被段规则抢走了明显错误的分类，而改规则顺序会波及别的标签。
 * 保持这份清单**短**：它每多一条，规则表的可解释性就少一分。
 *
 * ⚠️ 判「某条覆盖是不是多余的」有现成办法：把它删掉再跑一遍分类，结果不变的就是冗余的
 *    （`school` 那条本来就在，删掉后仍落 `indoor` —— 因为室内规则带 `school` 短语；
 *    而 `school_uniform` 那条**是承重的**：删掉它会被室内规则抢走）。
 */
const OVERRIDES = {
  original: 'source',
  absurdres: 'quality',
  highres: 'quality',
  lowres: 'quality',
  realistic: 'render',
  chibi: 'render',
  '3d': 'render',
  pixel_art: 'render',
  sketch: 'quality',
  lineart: 'quality',
  monochrome: 'palette',
  greyscale: 'palette',
  'spot_color': 'palette',
  comic: 'media_text',
  '1girl': 'count',
  '1boy': 'count',
  '2girls': 'count',
  '2boys': 'count',
  '3girls': 'count',
  '4girls': 'count',
  '5girls': 'count',
  '6+girls': 'count',
  '4koma': 'media_text',
  'sailor': 'identity',
  'serafuku': 'uniform',
};

/** 子类 id → 顶层分类 id（由 SUBS 派生，避免两处各写一遍导致漂移）。 */
const SUB_TO_CATEGORY = new Map(SUBS.map((s) => [s.id, s.category]));

const SUB_IDS = new Set(SUBS.map((s) => s.id));

/** 标签 → 子类 id 的缓存（5813 条，算一次就够）。 */
let cache = null;

/**
 * 一条标签的全部「边界短语」：所有**连续段**的组合。
 *
 * `long_hair` → `{long, hair, long_hair}`；`1girl` → `{1girl}`。
 *
 * 这是本模块匹配语义的核心。为什么不是「整段相等」：
 * 规则里天然会有 `long_sleeves` / `looking_at_viewer` 这种多段词，
 * 要求 token 恰好等于一整段 ⇒ 它们永远匹配不上（第一版就踩了这个坑，
 * `other` 桶因此积到 42%）。为什么不是「裸子串」：那会让 `loli` 命中 `hololive`、
 * 把 `lolita_fashion` 误杀 —— `ai/tag-labels.js` 里记着这个教训。
 * **边界短语 = 两者的交集**：允许跨段，但不许跨越段边界，误伤从「悄悄发生」
 * 变成「必须显式写出来」。
 */
function phrasesOf(tag) {
  const segs = String(tag).split('_');
  const set = new Set();
  for (let i = 0; i < segs.length; i++) {
    let acc = segs[i];
    set.add(acc);
    for (let j = i + 1; j < segs.length; j++) {
      acc += '_' + segs[j];
      set.add(acc);
    }
  }
  return set;
}

/**
 * 判定一条标签属于哪个子类。
 *
 * 顺序：OVERRIDES（整条相等）→ RULES（正则 / 边界短语 / 整条相等）→ `other`。
 */
function subOf(tag) {
  return classifyWith(RULES, tag, OVERRIDES);
}

/**
 * 用**指定的规则表 / 覆盖表**分类一条标签（`subOf` 的实现，也是守护做反向验证的入口）。
 *
 * 之所以把这一层单独暴露出来：守护要证明「规则表被改坏时上面的断言真的会红」，
 * 就必须**用改过的规则表跑真正的匹配引擎**。若让守护自己抄一份匹配逻辑，
 * 那份拷贝会随引擎演化而漂移，反向验证就变成了自证 —— 工程里对
 * 「桩必须接真模块、禁抄实现」是明确的硬要求。
 *
 * @param {Array} rules 规则表（形状同 RULES）
 * @param {string} tag
 * @param {object} [overrides] 覆盖表（默认 OVERRIDES）
 * @returns {string} 子类 id
 */
function classifyWith(rules, tag, overrides) {
  const ov = overrides || OVERRIDES;
  const t = String(tag == null ? '' : tag);
  if (!t) return 'other';
  if (Object.prototype.hasOwnProperty.call(ov, t)) return ov[t];
  const phrases = phrasesOf(t);
  for (const rule of rules) {
    if (rule.re && rule.re.test(t)) return rule.sub;
    if (rule.full && rule.full.includes(t)) return rule.sub;
    if (rule.seg) {
      for (const token of rule.seg) {
        if (phrases.has(token)) return rule.sub;
      }
    }
  }
  return 'other';
}

/** 标签 → `{ category, sub }`（`sub` 一定存在；查不到落 `other`）。 */
function categoryOf(tag) {
  const sub = subOf(tag);
  return { category: SUB_TO_CATEGORY.get(sub) || 'other', sub };
}

/** 建立「子类 → 标签数组」的完整映射（保序：按标签表下标）。 */
function buildIndex() {
  if (cache) return cache;
  const bySub = new Map(SUBS.map((s) => [s.id, []]));
  for (const label of labels()) {
    const sub = subOf(label);
    if (!bySub.has(sub)) bySub.set(sub, []);
    bySub.get(sub).push(label);
  }
  cache = bySub;
  return cache;
}

/** 某个子类下的标签（保序）。 */
function tagsOf(subId) {
  return (buildIndex().get(String(subId)) || []).slice();
}

/** 某个顶层分类下的全部标签（跨子类、保序）。 */
function tagsOfCategory(categoryId) {
  const out = [];
  for (const s of SUBS) {
    if (s.category !== String(categoryId)) continue;
    out.push(...tagsOf(s.id));
  }
  return out;
}

/** 三级树（顶层 → 子类），**不含标签**（标签按需取，避免一次吐 5813 条）。 */
function tree() {
  const idx = buildIndex();
  return CATEGORIES.map((c) => ({
    id: c.id,
    subs: SUBS.filter((s) => s.category === c.id).map((s) => ({
      id: s.id,
      tagTotal: (idx.get(s.id) || []).length,
    })),
  })).filter((c) => c.subs.length > 0);
}

/** 每个顶层分类的标签数（报告/守护用）。 */
function stats() {
  const idx = buildIndex();
  const byCategory = {};
  for (const c of CATEGORIES) {
    let n = 0;
    for (const s of SUBS) if (s.category === c.id) n += (idx.get(s.id) || []).length;
    byCategory[c.id] = n;
  }
  return byCategory;
}

module.exports = {
  CATEGORIES,
  SUBS,
  RULES,
  OVERRIDES,
  subOf,
  classifyWith,
  phrasesOf,
  categoryOf,
  tagsOf,
  tagsOfCategory,
  tree,
  stats,
  SUB_TO_CATEGORY,
  SUB_IDS,
};
