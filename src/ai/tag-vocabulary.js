'use strict';

/**
 * 「中文查询词 → danbooru 风格标签」的映射表 —— tag 检索路线的**唯一词源**。
 *
 * ## 它解决什么问题
 *
 * 搜图原来只有一条路：SigLIP2 双编码器，中文查询直接算向量、按基线差排序。那条路
 * **任意词都能收**，但精度不够。今天（2026-10-07）的台架实测（`docs/semantic-search-model-selection.md`）
 * 把结论定到「tag 提精度 + CLIP 保底」：27 个概念的前 10 命中，SigLIP2 单用 49/270、
 * JoyTag 单用 85/270（子集 A 1500 张，`rank-*.json`）。
 *
 * 但 tag 路线吃的不是中文，是 danbooru 标签。中间这一跳就是本文件。
 *
 * ## 为什么「词表的上限就是这条路的上限」
 *
 * JoyTag 是**闭集分类器**：输出维度 = 5813 个固定标签（`joytag-labels.txt`，随包）。
 * 它的标签表是 danbooru 的**高频前 5813 名**，构成极不均匀 —— 前半是 `1girl` / `solo` /
 * `long_hair` 这类人物与服饰，后半是 `ohara_mari` / `nishizumi_shiho` 这类**角色名**。
 * 于是：
 *
 *   - 服饰 / 造型 / 人物姿态 / 物件 / 室内 / 美食 → 覆盖很好，正是本库（动漫 cosplay 图包）的主场；
 *   - 自然风光 / 城市建筑 / 摄影风格 → **大面积缺失**（`canyon` / `valley` / `volcano` /
 *     `glacier` / `island` / `palace` / `subway` / `airport` / `highway` / `railway` /
 *     `plaza` / `fountain` / `living_room` / `wig` / `bee` / `yoga` / `skiing` / `surfing` /
 *     以及**全部九个基础色名** `red` `blue` `green` `yellow` `pink` `purple` `white` `black`
 *     `grey` 一个都没有）。这些词**不是没映射好，是模型真的不认**。
 *
 * 所以本文件里 `tags: []` 的条目**不是待办**，是结论。它们必须带 `missing`，
 * 写出「缺的是哪个标签名」—— 这是可核查的，也避免以后有人以为漏了。
 *
 * ⚠️ 反面教训：旧 308 词表的英文侧**原样**（去冠词 + 空格转下划线）去查标签表，
 * 只有 **138/308 = 44.8%** 命中，且命中的一半是「海滩 / 森林 / 沙漠」这类
 * **本库一张都没有**的风景词。所以「英文词能对上」这件事本身说明不了这条路可用 ——
 * 必须逐词给出**真在标签表里**的标签，缺一个都不行（标签不存在 ⇒ 该词在这条路上恒 0 命中，
 * 而这是**静默错**：界面不报错，只是没有结果）。
 *
 * ## 关于「代理标签」（下文中标 ⚠️代理 的条目）
 *
 * 有些概念的字面英文不在标签表里，但表里有一个**视觉上等价**的标签。这类只在该等价关系
 * 足够强时才采用，否则宁可留空：
 *
 *   - 采用：`银发` → `grey_hair` / `white_hair`（动漫里银发就是这两色，看不出区别）；
 *     `红色` → `red_theme` / `red_background`（danbooru 表达「整张图偏红」的标准写法）；
 *     `手办` → `doll` / `doll_joints`；`冲浪` → `surfboard`；`寺庙` → `shrine`。
 *   - **拒绝**：`闪光灯` —— 表里有个 `flashing`，但它在 danbooru 里是「当众暴露身体」，
 *     拿它当相机闪光灯会同时**答错**和**放出 NSFW 内容**。所以宁可留空。
 *
 * ## `mode` 的语义
 *
 *   - `'any'`（默认）：命中所列任一标签即可，打分取**各标签的最大分**。用于「这一类东西」的宽查询。
 *   - `'all'` ：所列标签**全部**要过阈值，打分取**最小分**。用于真正的复合词
 *     （「夕阳下的海滩」= beach ∧ sunset）。这类词若按 `any` 处理，会退化成最宽的那个标签。
 *
 * ## 用法
 *
 * ```js
 * const { lookup, isSupported } = require('./tag-vocabulary');
 * lookup('黑丝');   // → { tags: ['pantyhose', 'thighhighs'], mode: 'any' }
 * lookup('峡谷');   // → { tags: [], missing: ['canyon'], mode: 'any' }
 * lookup('随便什么'); // → null（自由词 ⇒ 只走 CLIP 路，界面必须说明，不许当 0 结果）
 * ```
 */

/** 所有标签都必须存在于 `joytag-labels.txt`（`scripts/tag-vocab-regression.js` 逐条断言）。 */
const TERMS = {
  // ---------- 自然风光 ----------
  海滩: { tags: ['beach', 'ocean', 'waves'] },
  夕阳下的海滩: { tags: ['beach', 'sunset'], mode: 'all' },
  海边的礁石: { tags: ['rock', 'cliff'] },
  海浪: { tags: ['waves', 'ocean'] },
  沙滩: { tags: ['beach', 'sand'] },
  雪山: { tags: ['snow', 'mountain'] },
  雪山和湖泊: { tags: ['mountain', 'lake'], mode: 'all' },
  湖泊: { tags: ['lake'] },
  森林: { tags: ['forest', 'tree'] },
  树林: { tags: ['tree', 'tree_shade'] },
  草地: { tags: ['grass'] },
  草原: { tags: ['field'] },
  沙漠: { tags: ['desert'] },
  瀑布: { tags: ['waterfall'] },
  溪流: { tags: ['river', 'waterfall'] },
  河流: { tags: ['river'] },
  峡谷: { tags: [], missing: ['canyon'] },
  火山: { tags: [], missing: ['volcano'] },
  冰川: { tags: [], missing: ['glacier'] },
  岛屿: { tags: [], missing: ['island'] },
  山谷: { tags: [], missing: ['valley'] },
  山间徒步: { tags: [], missing: ['hiking'] },
  山顶: { tags: ['mountain', 'mountainous_horizon'] },
  云海: { tags: ['cloudy_sky', 'sky'] },
  日落: { tags: ['sunset', 'dusk'] },
  日出: { tags: ['sunrise'] },
  星空: { tags: ['starry_sky', 'night_sky'] },
  夜空: { tags: ['night_sky', 'night'] },
  蓝天白云: { tags: ['blue_sky', 'cloudy_sky'] },
  彩虹: { tags: ['rainbow'] },
  花海: { tags: ['flower_field', 'field'] },
  樱花: { tags: ['cherry_blossoms'] },
  枫叶: { tags: ['maple_leaf', 'autumn_leaves'] },
  秋天的落叶: { tags: ['autumn_leaves'] },
  荷叶: { tags: ['lotus'] },
  竹林: { tags: ['bamboo_forest', 'bamboo'] },
  梯田: { tags: [], missing: ['terraced_fields'] },
  稻田: { tags: [], missing: ['rice_field'] },
  田野: { tags: ['field'] },
  泥土: { tags: [], missing: ['soil', 'dirt'] },
  岩石: { tags: ['rock'] },
  苔藓: { tags: ['moss'] },

  // ---------- 天气与季节 ----------
  下雪: { tags: ['snow', 'snowing', 'snowflakes'] },
  雪地: { tags: ['snow', 'snowing'] },
  雪后的街道: { tags: ['street', 'snow'], mode: 'all' },
  雨天: { tags: ['rain'] },
  雨天的倒影: { tags: ['rain', 'reflection'], mode: 'all' },
  雨伞: { tags: ['umbrella'] },
  雾: { tags: ['fog'] },
  阴天: { tags: ['cloudy_sky'] },
  晴天: { tags: ['blue_sky', 'day'] },
  乌云: { tags: ['cloudy_sky'] },
  闪电: { tags: ['lightning'] },
  春天: { tags: ['spring_(season)'] },
  夏天: { tags: ['summer'] },
  秋天: { tags: ['autumn'] },
  冬天: { tags: ['winter'] },
  黄昏: { tags: ['dusk', 'sunset'] },
  夜晚: { tags: ['night'] },
  清晨: { tags: [], missing: ['early_morning', 'morning'] },

  // ---------- 城市与建筑 ----------
  城市夜景: { tags: ['city_lights', 'cityscape'] },
  高楼: { tags: ['skyscraper', 'building'] },
  街道: { tags: ['street'] },
  街上的行人: { tags: ['street', 'crowd'] },
  小巷: { tags: ['alley'] },
  桥梁: { tags: ['bridge'] },
  古建筑: { tags: ['ruins'] },
  寺庙: { tags: ['shrine'] }, // ⚠️代理：中国寺庙 ≈ 日本神社，视觉上够近
  教堂: { tags: ['church'] },
  城堡: { tags: ['castle'] },
  宫殿: { tags: [], missing: ['palace'] },
  地铁: { tags: ['train_interior'] }, // ⚠️代理：没有 subway 标签，用地铁/车厢内景
  车站: { tags: ['train_station'] },
  机场: { tags: [], missing: ['airport'] },
  公路: { tags: ['road'] },
  铁轨: { tags: ['railroad_tracks'] },
  天台: { tags: ['rooftop'] },
  广场: { tags: [], missing: ['plaza'] },
  喷泉: { tags: [], missing: ['fountain'] },
  霓虹灯: { tags: ['city_lights'] }, // ⚠️代理：无 neon_lights
  招牌: { tags: ['sign'] },
  窗户: { tags: ['window'] },
  楼梯: { tags: ['stairs'] },
  走廊: { tags: ['hallway'] },
  玻璃幕墙: { tags: [], missing: ['glass_facade', 'curtain_wall'] },

  // ---------- 人物与生活 ----------
  人物肖像: { tags: ['portrait'] },
  人像写真: { tags: ['portrait', 'photo_background'] },
  自拍: { tags: ['selfie'] },
  合影: { tags: ['multiple_girls', 'multiple_boys'] },
  背影: { tags: ['from_behind'] },
  侧脸: { tags: ['profile'] },
  特写脸部: { tags: ['close-up', 'portrait'] },
  微笑: { tags: ['smile'] },
  大笑: { tags: ['laughing'] },
  哭泣: { tags: ['crying', 'tears'] },
  儿童: { tags: ['child'] },
  婴儿: { tags: ['baby'] },
  老人: { tags: ['old_woman', 'old_man'] },
  情侣: { tags: ['couple'] },
  婚礼: { tags: ['wedding', 'wedding_dress'] },
  毕业照: { tags: [], missing: ['graduation'] },
  生日聚会: { tags: ['birthday', 'cake'] },
  举杯: { tags: ['drinking_glass', 'holding_cup'] },
  聚会: { tags: ['milestone_celebration', 'confetti', 'banner'] }, // ⚠️代理：无 party
  跳舞: { tags: ['dancing'] },
  舞台演出: { tags: ['stage', 'stage_lights'] },
  唱歌: { tags: ['singing'] },
  弹吉他: { tags: ['guitar', 'playing_instrument'] },
  弹钢琴: { tags: ['piano', 'playing_instrument'] },
  画画: { tags: ['drawing'] },
  看书: { tags: ['reading', 'holding_book'] },
  喝茶: { tags: ['tea', 'teacup'] },
  喝咖啡: { tags: ['coffee', 'coffee_cup'] },
  吃饭: { tags: ['eating', 'food'] },
  睡觉: { tags: ['sleeping'] },
  跑步: { tags: ['running'] },
  骑车: { tags: ['bicycle'] },
  游泳: { tags: ['swimming'] },
  露营: { tags: [], missing: ['camping', 'tent'] },
  钓鱼: { tags: ['fishing', 'fishing_rod'] },
  滑雪: { tags: [], missing: ['skiing', 'snowboard'] },
  冲浪: { tags: ['surfboard'] }, // ⚠️代理：无 surfing，用冲浪板
  瑜伽: { tags: ['stretch'] }, // ⚠️代理：无 yoga，用「伸展」动作
  健身: { tags: ['exercise', 'gym_shirt', 'sportswear'] },
  打球: { tags: ['holding_ball'] },
  拍照的人: { tags: ['holding_camera', 'camera'] },
  抱着宠物: { tags: ['holding_animal', 'holding_cat'] },
  打电话: { tags: ['holding_phone', 'phone'] },
  看镜头: { tags: ['looking_at_viewer'] },
  回头: { tags: ['looking_back'] },
  躺着: { tags: ['lying'] },
  坐着: { tags: ['sitting'] },
  站着: { tags: ['standing'] },
  伸展手臂: { tags: ['outstretched_arm', 'arms_up'] },
  比手势: { tags: ['thumbs_up', 'double_v', 'pointing'] },

  // ---------- 服饰与造型 ----------
  cosplay: { tags: ['cosplay', 'cosplay_photo', 'costume'] },
  制服: { tags: ['school_uniform', 'uniform', 'serafuku'] },
  校服: { tags: ['school_uniform', 'serafuku'] },
  水手服: { tags: ['serafuku', 'sailor', 'sailor_collar', 'sailor_dress'] },
  和服: { tags: ['kimono', 'japanese_clothes', 'yukata'] },
  汉服: { tags: ['hanfu', 'chinese_clothes'] },
  旗袍: { tags: ['china_dress', 'chinese_clothes'] },
  婚纱: { tags: ['wedding_dress', 'wedding'] },
  西装: { tags: ['suit', 'suit_jacket'] },
  连衣裙: { tags: ['dress', 'sundress'] },
  短裙: { tags: ['miniskirt', 'skirt', 'pleated_skirt'] },
  泳装: { tags: ['swimsuit', 'one-piece_swimsuit', 'school_swimsuit', 'competition_swimsuit'] },
  比基尼: { tags: ['bikini', 'sports_bikini'] },
  丝袜: { tags: ['pantyhose', 'thighhighs'] },
  长靴: { tags: ['boots', 'knee_boots', 'thigh_boots'] },
  高跟鞋: { tags: ['high_heels'] },
  帽子: { tags: ['hat', 'beret'] },
  兔耳: { tags: ['rabbit_ears'] },
  猫耳: { tags: ['cat_ears'] },
  眼镜: { tags: ['glasses'] },
  面具: { tags: ['mask'] },
  假发: { tags: [], missing: ['wig'] },
  长发: { tags: ['long_hair', 'very_long_hair'] },
  短发: { tags: ['short_hair'] },
  双马尾: { tags: ['twintails', 'short_twintails', 'low_twintails'] },
  马尾辫: { tags: ['ponytail', 'side_ponytail', 'braided_ponytail'] },
  银发: { tags: ['grey_hair', 'white_hair'] }, // ⚠️代理：无 silver_hair
  金发: { tags: ['blonde_hair'] },
  粉发: { tags: ['pink_hair'] },
  蓝发: { tags: ['blue_hair'] },
  刘海: { tags: ['bangs', 'hair_between_eyes'] },
  化妆: { tags: ['makeup', 'lipstick', 'blush'] },
  口红: { tags: ['lipstick'] },
  纹身: { tags: ['tattoo'] },
  盔甲: { tags: ['armor'] },
  斗篷: { tags: ['cape', 'cloak', 'capelet'] },
  翅膀: { tags: ['wings'] },
  尾巴: { tags: ['tail'] },
  武器: { tags: ['holding_weapon'] },
  手持刀剑: { tags: ['holding_sword'] },
  丝带: { tags: ['ribbon', 'hair_ribbon'] },
  蕾丝: { tags: ['lace', 'frills'] },
  项链: { tags: ['necklace', 'choker'] },
  耳环: { tags: ['earrings'] },
  背包: { tags: ['backpack', 'school_bag'] },
  手持扇子: { tags: ['holding_fan', 'hand_fan'] },
  撑着伞: { tags: ['holding_umbrella', 'umbrella', 'parasol'] },

  // ---------- 题材与风格 ----------
  街拍: { tags: ['street'] },
  棚拍: { tags: ['photo_background', 'simple_background'] },
  室内: { tags: ['indoors'] },
  室外: { tags: ['outdoors'] },
  逆光: { tags: ['backlighting'] },
  剪影: { tags: ['silhouette'] },
  特写: { tags: ['close-up'] },
  远景: { tags: ['wide_shot', 'full_body'] },
  俯拍: { tags: ['from_above'] },
  仰拍: { tags: ['from_below'] },
  镜面反射: { tags: ['mirror', 'reflection'] },
  水中倒影: { tags: ['reflection'] },
  黑白照片: { tags: ['monochrome', 'greyscale'] },
  胶片感: { tags: ['film_grain'] },
  复古风: { tags: ['retro_artstyle'] },
  唯美: { tags: [], missing: ['dreamy', 'aesthetic'] },
  清新: { tags: [], missing: ['fresh'] },
  日系: { tags: [], missing: ['japanese_style'] },
  暗黑风: { tags: ['dark_background'] },
  高饱和: { tags: ['colorful'] },
  低饱和: { tags: ['muted_color'] },
  柔和光线: { tags: [], missing: ['soft_lighting'] },
  强阴影: { tags: ['shadow', 'high_contrast'] }, // ⚠️代理：无 harsh_shadows
  暖色调: { tags: ['orange_theme', 'sepia'] }, // ⚠️代理：无 warm_colors
  冷色调: { tags: ['blue_theme', 'blue_background'] }, // ⚠️代理：无 cool_colors
  浅景深: { tags: ['depth_of_field', 'blurry_background'] },
  虚化背景: { tags: ['blurry_background', 'bokeh'] },
  长曝光: { tags: ['light_trail', 'motion_blur'] }, // ⚠️代理：无 long_exposure
  闪光灯: { tags: [], missing: ['flash', 'camera_flash'] }, // 拒绝用 flashing（语义是当众暴露，非相机闪光）
  窗光: { tags: ['dappled_sunlight', 'sunbeam'] }, // ⚠️代理：无 window_light
  动漫插画: { tags: ['anime_coloring'] }, // ⚠️代理：无 anime / illustration
  '3D渲染': { tags: ['3d'] },
  像素风: { tags: ['pixel_art'] },
  水彩画: { tags: ['watercolor_(medium)'] },
  油画: { tags: ['painting_(medium)'] }, // ⚠️代理：无 oil_painting，用「绘画媒介」
  素描: { tags: ['sketch', 'pencil'] },
  手办: { tags: ['doll_joints', 'doll'] }, // ⚠️代理：无 figurine
  玩偶: { tags: ['stuffed_toy', 'doll'] },
  海报: { tags: ['poster_(object)'] },

  // ---------- 美食 ----------
  美食特写: { tags: ['food_focus', 'food'] },
  蛋糕: { tags: ['cake', 'cake_slice', 'cupcake'] },
  甜点: { tags: ['dessert', 'sweets'] },
  咖啡: { tags: ['coffee', 'coffee_cup', 'coffee_mug'] },
  咖啡馆一角: { tags: ['restaurant'] }, // ⚠️代理：无 cafe / coffee_shop
  奶茶: { tags: ['bubble_tea'] },
  火锅: { tags: [], missing: ['hot_pot'] },
  烧烤: { tags: [], missing: ['barbecue'] },
  寿司: { tags: ['sushi'] },
  拉面: { tags: ['ramen'] },
  面包: { tags: ['bread'] },
  水果: { tags: ['fruit'] },
  餐桌上的水果: { tags: ['fruit', 'table'], mode: 'all' },
  冰淇淋: { tags: ['ice_cream', 'ice_cream_cone'] },
  红酒: { tags: ['wine', 'wine_glass', 'wine_bottle'] },
  啤酒: { tags: ['beer', 'beer_mug'] },
  餐桌: { tags: ['table'] },
  便当: { tags: ['bento'] },
  蔬菜: { tags: ['vegetable'] },
  海鲜: { tags: ['shrimp', 'crab'] }, // ⚠️代理：无 seafood

  // ---------- 动物 ----------
  // ⚠️ 「猫」在这个库里指猫耳/猫尾 cosplay，不是真猫 —— 实测 `桃良阿宅NO.025猫猫`
  //    图包里 `cat_ears` 0.54~0.58、`tail` 0.68，而 `cat` 只有 0.10~0.19。
  //    所以把 `cat_ears` 一并放进来；只写 `cat` 的话这个词在这个库上等于哑的。
  猫: { tags: ['cat', 'cat_girl', 'cat_ears'] },
  沙发上的猫: { tags: ['cat', 'couch'], mode: 'all' },
  狗: { tags: ['dog', 'dog_girl'] },
  鸟: { tags: ['bird'] },
  鱼: { tags: ['fish'] },
  // 同理：这个库里的「兔子」主要是兔耳/兔女郎 cosplay，`rabbit_girl` 只有 0.05~0.16，
  // 而正样本里出现过 `rabbit_ears` 0.49。两者都要。
  兔子: { tags: ['rabbit_girl', 'stuffed_bunny', 'rabbit_ears'] },
  马: { tags: ['horse', 'horse_girl'] },
  熊猫: { tags: ['panda'] },
  蝴蝶: { tags: ['butterfly'] },
  蜜蜂: { tags: ['bug'] }, // ⚠️代理：无 bee / insect，只有泛化的 bug
  宠物: { tags: ['animal_focus', 'holding_animal'] },

  // ---------- 物件 ----------
  盛开的花朵: { tags: ['flower', 'bloom', 'flower_field'] },
  花束: { tags: ['bouquet', 'holding_bouquet'] },
  盆栽: { tags: ['potted_plant', 'flower_pot'] },
  窗边的绿植: { tags: ['potted_plant', 'window'], mode: 'all' },
  树: { tags: ['tree', 'tree_shade'] },
  书: { tags: ['book', 'book_stack', 'bookshelf', 'notebook'] },
  相机: { tags: ['camera', 'holding_camera'] },
  手机: { tags: ['cellphone', 'smartphone', 'phone'] },
  笔记本电脑: { tags: ['laptop'] },
  键盘: { tags: ['keyboard_(computer)', 'keyboard_(instrument)'] },
  吉他: { tags: ['guitar'] },
  钢琴: { tags: ['piano'] },
  小提琴: { tags: ['violin'] },
  自行车: { tags: ['bicycle'] },
  汽车: { tags: ['car', 'car_interior'] },
  摩托车: { tags: ['motorcycle'] },
  船: { tags: ['boat'] },
  飞机: { tags: ['airplane'] },
  火车: { tags: ['train', 'train_interior'] },
  气球: { tags: ['balloon'] },
  蜡烛: { tags: ['candle'] },
  灯笼: { tags: ['paper_lantern', 'lantern'] },
  烟花: { tags: ['fireworks'] },
  玩具: { tags: ['toy', 'stuffed_toy', 'doll'] },
  镜子: { tags: ['mirror'] },
  窗帘: { tags: ['curtains'] },
  台灯: { tags: ['lamp', 'light_bulb'] },
  时钟: { tags: ['clock'] },
  杯子: { tags: ['cup', 'teacup', 'coffee_cup'] },
  瓶子: { tags: ['bottle'] },
  花盆: { tags: ['flower_pot'] },

  // ---------- 室内场景 ----------
  卧室: { tags: ['bedroom', 'bed'] },
  厨房: { tags: ['kitchen'] },
  书房: { tags: ['desk', 'bookshelf'] }, // ⚠️代理：无 study_room，用书桌/书架
  客厅: { tags: ['couch', 'armchair'] }, // ⚠️代理：无 living_room，用沙发/扶手椅
  教室: { tags: ['classroom', 'school_desk'] },
  图书馆: { tags: ['library'] },
  健身房: { tags: ['exercise', 'gym_uniform'] },
  后台: { tags: [], missing: ['backstage'] },
  化妆间: { tags: ['dressing'] }, // ⚠️代理：无 dressing_room
  浴室: { tags: ['bathroom', 'bathtub', 'showering'] },
  楼梯间: { tags: ['stairs', 'hallway'] },
  阳台: { tags: ['balcony'] },

  // ---------- 色调与节日 ----------
  红色: { tags: ['red_theme', 'red_background'] }, // ⚠️代理：无裸 red 标签
  蓝色: { tags: ['blue_theme', 'blue_background'] },
  绿色: { tags: ['green_theme', 'green_background'] },
  黄色: { tags: ['yellow_theme', 'yellow_background'] },
  粉色: { tags: ['pink_theme', 'pink_background'] },
  紫色: { tags: ['purple_theme', 'purple_background'] },
  白色: { tags: ['white_theme', 'white_background'] },
  黑色: { tags: ['black_background'] }, // ⚠️代理：无 black_theme（black_background 存在）
  金色: { tags: ['gold'] },
  圣诞: { tags: ['santa_costume', 'santa_hat', 'candy_cane', 'snowman'] },
  万圣节: { tags: ['halloween', 'halloween_costume'] },
  新年: { tags: ['new_year'] },
  灯笼夜景: { tags: ['paper_lantern', 'night'], mode: 'all' },

  // ---------- 台架概念（不在 308 预选词表里，但有正样本证据，也必须能查） ----------
  //
  // 为什么它们要在这里：`search-vocabulary.js#TERMS` 只是**界面预选词**的词源，
  // 而检索框收的是**自由词** —— 用户可以打「女仆」，这条查询走的还是同一条管线。
  // 所以「308 词表里没有」不等于「不用支持」。下面这 15 个词来自
  // `probes.js`（图包名当弱标签，每个都有几十到几百张正样本），是**有证据**的用户意图；
  // 其中 5 个（黑丝/白丝/空姐/…）恰恰是台架上 tag 路打不出来的那几个，
  // 写在这里当**结论**，比留在 probes.js 里当「待办」清楚。
  JK制服: { tags: ['school_uniform', 'serafuku', 'pleated_skirt'] },
  女仆: { tags: ['maid', 'maid_headdress', 'maid_apron'] },
  // 🔴 黑丝 / 白丝 是本方案最典型的一个「诚实留空」：
  //    JoyTag 的腿部服饰标签只有 pantyhose / thighhighs / fishnets / socks / kneehighs，
  //    **没有任何带颜色的变体**（black_thighhighs、white_thighhighs、white_socks 全不在表里）。
  //    硬把它们指向 `pantyhose` / `thighhighs` 的后果是「搜『白丝』返回黑丝图」——
  //    而且这条错结果还会经 RRF 融合**污染 CLIP 的结果**。所以宁可留空，
  //    由 CLIP 单独兜（不变式 2），并在界面上明说该词未启用标签检索（不变式 5）。
  黑丝: { tags: [], missing: ['black_pantyhose', 'black_thighhighs'] },
  白丝: { tags: [], missing: ['white_pantyhose', 'white_thighhighs', 'white_socks'] },
  网袜: { tags: ['fishnets'] },
  吊带: { tags: ['camisole', 'garter_belt'] },
  毛衣: { tags: ['sweater', 'turtleneck'] },
  内衣: { tags: ['underwear', 'lingerie', 'bra'] },
  死库水: { tags: ['school_swimsuit', 'competition_swimsuit'] },
  绳艺: { tags: ['bondage', 'ribbon_bondage'] },
  护士: { tags: ['nurse', 'nurse_cap'] },
  洗手间: { tags: ['toilet', 'bathroom'] },
  // 🔴 停车场：模型词表里只有 `car`，没有 `parking_lot`。曾经用过 `car`，但实测反证了它 ——
  //    语料里 11 张正样本（图包名带「停车场」）上 `car` 的最大分只有 **0.0346**（纯噪声量级），
  //    也就是说拿它去查停车场，返回的是「图里有一辆车」而不是「停车场」。宁可不支持。
  停车场: { tags: [], missing: ['parking_lot'] },
  空姐: { tags: [], missing: ['flight_attendant', 'stewardess'] }, // danbooru 有 flight_attendant，这个模型的 5813 表里没有
  兔女郎: { tags: ['playboy_bunny'] },
  鲜花: { tags: ['flower', 'bouquet'] },
};

/**
 * 查一个查询词的标签映射。
 *
 * @param {string} term 查询词（原样，中文）
 * @returns {{tags:string[], mode:'any'|'all', missing?:string[]}|null}
 *   不在表里返回 `null`（自由词 ⇒ 只走 CLIP 路）；表里但 `tags` 为空 ⇒ tag 路不参与。
 */
function lookup(term) {
  const entry = TERMS[String(term == null ? '' : term).trim()];
  if (!entry) return null;
  return {
    tags: entry.tags.slice(),
    mode: entry.mode === 'all' ? 'all' : 'any',
    missing: entry.missing ? entry.missing.slice() : undefined,
  };
}

/** 该词在 tag 路线上是否可用（有非空标签）。不在表里或标签为空都返回 `false`。 */
function isSupported(term) {
  const entry = TERMS[String(term == null ? '' : term).trim()];
  return Boolean(entry && entry.tags.length);
}

/**
 * 词表内容指纹 —— 「这张表是哪一版」的**唯一判据**。
 *
 * ## 为什么不能用手写版本号
 *
 * 手写的 `VOCAB_VERSION = 3` 在「改了映射忘了抬号」时完全无效，而那正是唯一需要检测的时刻。
 * 内容哈希没有这个问题：改任何一条映射，指纹必然变。
 *
 * ## 为什么必须放在这里（而不是各脚本自己算）
 *
 * 这个指纹有三个消费者，口径必须**逐字符一致**，否则会出现最坏的情形：
 * `scripts/tag-vocab-rebuild.js` 认为「没变」（于是不提示重跑），而
 * `scripts/tag-vocab-regression.js` 认为「变了」（于是判红）—— 两边各说各话，
 * 人会去改其中一个让它变绿，而真正的问题（该重跑语料验证）被掩盖。
 * 所以这里导出它，两个脚本都 `require`，绝不本地重写。
 *
 * ## 口径
 *
 * 键排序 ⇒ 只挪动词序或改注释/空行**不**改指纹；改任何一条的 `tags` / `mode` / `missing`
 * ⇒ **必须**改指纹。与 `photo-tags.js#vocabKey` 同形（djb2 + 前缀），
 * 让「词表指纹」在这个项目里只有一种长相。
 *
 * @param {object} [terms] 默认作用于本模块的 `TERMS`（测试与反向验证时可传入改过的副本）
 */
function vocabFingerprint(terms) {
  const source = Object.keys(terms || TERMS)
    .sort()
    .map((key) => {
      const e = (terms || TERMS)[key] || {};
      return [key, (e.tags || []).join(','), e.mode || 'any', (e.missing || []).join(',')].join('\u0001');
    })
    .join('\u0002');
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
  return 'tv1:' + hash.toString(16);
}

module.exports = { TERMS, lookup, isSupported, vocabFingerprint };
