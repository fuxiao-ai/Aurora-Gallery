'use strict';

/**
 * 搜图预选词的**词源**。
 *
 * ## 为什么需要它，以及它为什么仍然是人写的
 *
 * 预选词要回答的问题是「给我几个点下去真有图的词」。原来的做法是界面里写死 18 个词、
 * 再用「这些词在这个库里有没有内容」筛一遍；筛完一个都不剩时就**回退整份静态词库**，
 * 于是用户看到的永远是那 18 个词，而本机库（以动漫 / cosplay 图包为主）里它们 18 个中
 * 有 13 个是 0 张 —— 点下去什么都没有。根子不在筛选，在**词源太窄**：18 个词全是通用风景，
 * 库里根本没有「夕阳下的海滩」这种东西。
 *
 * 但词源不可能像检索那样「从图库里长出来」：SigLIP2 是**双编码器**（文本塔 + 图像塔），
 * 没有解码器，从入库的图像向量里吐不出任何一个词。要真从图里生词必须再挂一个 caption
 * 模型（BLIP-2 / LLaVA 那类），那是另一套模型、另一份内存、另一段索引时间。
 *
 * 所以这里采取的是**够宽的人写词表 + 数据驱动的筛选与排序**：
 *   - 词表尽量宽（覆盖风景 / 城市 / 人物 / 服饰造型 / 题材风格 / 美食 / 动物 / 物件 / 室内 /
 *     色调节日十类），宽到「任何一类图库都能被命中几个」；服饰造型与题材风格两类的词
 *     （泳装、制服、双马尾、银发、棚拍、逆光、黑白照片…）就是为动漫 / cosplay 库补的；
 *   - **显示哪几个词由库决定**：每个词都按检索同一套口径（基线差 + 当前阈值）在这个库里
 *     实际跑一遍，按真实命中数排序取前 N。所以「点下去有图」是算出来的，不是猜的。
 *
 * ## 中英两版都要给
 *
 * SigLIP2 的文本塔是在英文图文对上训练的，英文描述通常比中文更贴近它的语义空间，
 * 但中文检索实测并不弱（同义改写 top-60 重合中文 44 / 英文 49），且界面需要本地化，
 * 所以每个词都写成 `[中文, 英文]`。两版是**同一个词**的两种说法，命中数可以不同，
 * 各自按自己的命中数参与排序。
 *
 * ## 新增词的门槛
 *
 * 一个词要值得放进来的标准是「它描述的是画面里**看得见**的东西」。抽象概念
 * （「孤独」「回忆」）在双编码器里没有稳定所指，实测分数与乱码接近，加了只会污染候选池。
 */

/** 十类词表，注释只为人读；程序不关心分类，排序完全由命中数决定。 */
const TERMS = [
  // ---------- 自然风光 ----------
  ['海滩', 'a beach'],
  ['夕阳下的海滩', 'a beach at sunset'],
  ['海边的礁石', 'rocks by the sea'],
  ['海浪', 'waves'],
  ['沙滩', 'sand on the beach'],
  ['雪山', 'snowy mountains'],
  ['雪山和湖泊', 'a lake below snowy mountains'],
  ['湖泊', 'a lake'],
  ['森林', 'a forest'],
  ['树林', 'trees'],
  ['草地', 'grassland'],
  ['草原', 'a vast grassland'],
  ['沙漠', 'a desert'],
  ['瀑布', 'a waterfall'],
  ['溪流', 'a stream'],
  ['河流', 'a river'],
  ['峡谷', 'a canyon'],
  ['火山', 'a volcano'],
  ['冰川', 'a glacier'],
  ['岛屿', 'an island'],
  ['山谷', 'a valley'],
  ['山间徒步', 'hiking in the mountains'],
  ['山顶', 'a mountain peak'],
  ['云海', 'a sea of clouds'],
  ['日落', 'a sunset'],
  ['日出', 'a sunrise'],
  ['星空', 'a starry sky'],
  ['夜空', 'the night sky'],
  ['蓝天白云', 'blue sky and white clouds'],
  ['彩虹', 'a rainbow'],
  ['花海', 'a field of flowers'],
  ['樱花', 'cherry blossoms'],
  ['枫叶', 'maple leaves'],
  ['秋天的落叶', 'autumn leaves'],
  ['荷叶', 'lotus leaves'],
  ['竹林', 'a bamboo forest'],
  ['梯田', 'terraced fields'],
  ['稻田', 'a rice field'],
  ['田野', 'a field'],
  ['泥土', 'soil'],
  ['岩石', 'rocks'],
  ['苔藓', 'moss'],

  // ---------- 天气与季节 ----------
  ['下雪', 'snowfall'],
  ['雪地', 'snowy ground'],
  ['雪后的街道', 'a street after snow'],
  ['雨天', 'a rainy day'],
  ['雨天的倒影', 'reflections on a rainy day'],
  ['雨伞', 'an umbrella'],
  ['雾', 'fog'],
  ['阴天', 'an overcast sky'],
  ['晴天', 'a clear day'],
  ['乌云', 'dark clouds'],
  ['闪电', 'lightning'],
  ['春天', 'spring'],
  ['夏天', 'summer'],
  ['秋天', 'autumn'],
  ['冬天', 'winter'],
  ['黄昏', 'dusk'],
  ['夜晚', 'at night'],
  ['清晨', 'early morning'],

  // ---------- 城市与建筑 ----------
  ['城市夜景', 'city skyline at night'],
  ['高楼', 'tall buildings'],
  ['街道', 'a street'],
  ['街上的行人', 'people walking on the street'],
  ['小巷', 'a narrow alley'],
  ['桥梁', 'a bridge'],
  ['古建筑', 'old architecture'],
  ['寺庙', 'a temple'],
  ['教堂', 'a church'],
  ['城堡', 'a castle'],
  ['宫殿', 'a palace'],
  ['地铁', 'a subway'],
  ['车站', 'a train station'],
  ['机场', 'an airport'],
  ['公路', 'a highway'],
  ['铁轨', 'railway tracks'],
  ['天台', 'a rooftop'],
  ['广场', 'a plaza'],
  ['喷泉', 'a fountain'],
  ['霓虹灯', 'neon lights'],
  ['招牌', 'a shop sign'],
  ['窗户', 'a window'],
  ['楼梯', 'stairs'],
  ['走廊', 'a corridor'],
  ['玻璃幕墙', 'a glass facade'],

  // ---------- 人物与生活 ----------
  ['人物肖像', 'a portrait of a person'],
  ['人像写真', 'a portrait photoshoot'],
  ['自拍', 'a selfie'],
  ['合影', 'a group photo'],
  ['背影', 'a person seen from behind'],
  ['侧脸', 'a profile view of a face'],
  ['特写脸部', 'a close-up of a face'],
  ['微笑', 'a smile'],
  ['大笑', 'laughing'],
  ['哭泣', 'crying'],
  ['儿童', 'a child'],
  ['婴儿', 'a baby'],
  ['老人', 'an elderly person'],
  ['情侣', 'a couple'],
  ['婚礼', 'a wedding'],
  ['毕业照', 'a graduation photo'],
  ['生日聚会', 'a birthday party'],
  ['举杯', 'raising a glass'],
  ['聚会', 'a party'],
  ['跳舞', 'dancing'],
  ['舞台演出', 'a stage performance'],
  ['唱歌', 'singing'],
  ['弹吉他', 'playing the guitar'],
  ['弹钢琴', 'playing the piano'],
  ['画画', 'drawing'],
  ['看书', 'reading a book'],
  ['喝茶', 'drinking tea'],
  ['喝咖啡', 'drinking coffee'],
  ['吃饭', 'eating'],
  ['睡觉', 'sleeping'],
  ['跑步', 'running'],
  ['骑车', 'riding a bicycle'],
  ['游泳', 'swimming'],
  ['露营', 'camping'],
  ['钓鱼', 'fishing'],
  ['滑雪', 'skiing'],
  ['冲浪', 'surfing'],
  ['瑜伽', 'yoga'],
  ['健身', 'working out'],
  ['打球', 'playing ball'],
  ['拍照的人', 'a person taking a photo'],
  ['抱着宠物', 'holding a pet'],
  ['打电话', 'talking on the phone'],
  ['看镜头', 'looking at the camera'],
  ['回头', 'looking back over the shoulder'],
  ['躺着', 'lying down'],
  ['坐着', 'sitting'],
  ['站着', 'standing'],
  ['伸展手臂', 'arms outstretched'],
  ['比手势', 'making a hand gesture'],

  // ---------- 服饰与造型 ----------
  ['cosplay', 'cosplay'],
  ['制服', 'a uniform'],
  ['校服', 'a school uniform'],
  ['水手服', 'a sailor uniform'],
  ['和服', 'a kimono'],
  ['汉服', 'traditional Chinese clothing'],
  ['旗袍', 'a cheongsam'],
  ['婚纱', 'a wedding dress'],
  ['西装', 'a suit'],
  ['连衣裙', 'a dress'],
  ['短裙', 'a short skirt'],
  ['泳装', 'a swimsuit'],
  ['比基尼', 'a bikini'],
  ['丝袜', 'stockings'],
  ['长靴', 'boots'],
  ['高跟鞋', 'high heels'],
  ['帽子', 'a hat'],
  ['兔耳', 'bunny ears'],
  ['猫耳', 'cat ears'],
  ['眼镜', 'glasses'],
  ['面具', 'a mask'],
  ['假发', 'a wig'],
  ['长发', 'long hair'],
  ['短发', 'short hair'],
  ['双马尾', 'twintails'],
  ['马尾辫', 'a ponytail'],
  ['银发', 'silver hair'],
  ['金发', 'blonde hair'],
  ['粉发', 'pink hair'],
  ['蓝发', 'blue hair'],
  ['刘海', 'bangs'],
  ['化妆', 'makeup'],
  ['口红', 'lipstick'],
  ['纹身', 'a tattoo'],
  ['盔甲', 'armor'],
  ['斗篷', 'a cloak'],
  ['翅膀', 'wings'],
  ['尾巴', 'a tail'],
  ['武器', 'a weapon'],
  ['手持刀剑', 'holding a sword'],
  ['丝带', 'ribbons'],
  ['蕾丝', 'lace'],
  ['项链', 'a necklace'],
  ['耳环', 'earrings'],
  ['背包', 'a backpack'],
  ['手持扇子', 'holding a fan'],
  ['撑着伞', 'holding an umbrella'],

  // ---------- 题材与风格 ----------
  ['街拍', 'street photography'],
  ['棚拍', 'a studio photo'],
  ['室内', 'indoors'],
  ['室外', 'outdoors'],
  ['逆光', 'backlit'],
  ['剪影', 'a silhouette'],
  ['特写', 'a close-up'],
  ['远景', 'a wide shot'],
  ['俯拍', 'a shot from above'],
  ['仰拍', 'a shot from below'],
  ['镜面反射', 'a mirror reflection'],
  ['水中倒影', 'a reflection in the water'],
  // 🔴 词条是**数据**不是文案：zh 是用户点的那一下、en 直接进模型前向。整条 TERMS
  //    同时兼任 `tag-vocabulary.js` 的零样本词表，改名会让已建索引的口径漂。
  //    「统一 照片/图片 用词」那类全局替换必须把它排除。
  ['黑白照片', 'a black and white photo'],
  ['胶片感', 'a film look'],
  ['复古风', 'a retro style'],
  ['唯美', 'a dreamy aesthetic'],
  ['清新', 'a fresh and clean look'],
  ['日系', 'a Japanese style photo'],
  ['暗黑风', 'a dark moody style'],
  ['高饱和', 'highly saturated colors'],
  ['低饱和', 'desaturated colors'],
  ['柔和光线', 'soft lighting'],
  ['强阴影', 'harsh shadows'],
  ['暖色调', 'warm tones'],
  ['冷色调', 'cool tones'],
  ['浅景深', 'shallow depth of field'],
  ['虚化背景', 'a blurred background'],
  ['长曝光', 'a long exposure'],
  ['闪光灯', 'flash lighting'],
  ['窗光', 'window light'],
  ['动漫插画', 'an anime illustration'],
  ['3D渲染', 'a 3D render'],
  ['像素风', 'pixel art'],
  ['水彩画', 'a watercolor painting'],
  ['油画', 'an oil painting'],
  ['素描', 'a pencil sketch'],
  ['手办', 'a figurine'],
  ['玩偶', 'a plush toy'],
  ['海报', 'a poster'],

  // ---------- 美食 ----------
  ['美食特写', 'close-up of food'],
  ['蛋糕', 'a cake'],
  ['甜点', 'a dessert'],
  ['咖啡', 'a cup of coffee'],
  ['咖啡馆一角', 'a corner of a café'],
  ['奶茶', 'bubble tea'],
  ['火锅', 'a hot pot'],
  ['烧烤', 'barbecue'],
  ['寿司', 'sushi'],
  ['拉面', 'a bowl of ramen'],
  ['面包', 'bread'],
  ['水果', 'fruit'],
  ['餐桌上的水果', 'fruit on the table'],
  ['冰淇淋', 'ice cream'],
  ['红酒', 'a glass of red wine'],
  ['啤酒', 'beer'],
  ['餐桌', 'a dining table'],
  ['便当', 'a bento box'],
  ['蔬菜', 'vegetables'],
  ['海鲜', 'seafood'],

  // ---------- 动物 ----------
  ['猫', 'a cat'],
  ['沙发上的猫', 'a cat on a sofa'],
  ['狗', 'a dog'],
  ['鸟', 'a bird'],
  ['鱼', 'fish'],
  ['兔子', 'a rabbit'],
  ['马', 'a horse'],
  ['熊猫', 'a panda'],
  ['蝴蝶', 'a butterfly'],
  ['蜜蜂', 'a bee'],
  ['宠物', 'a pet'],

  // ---------- 物件 ----------
  ['盛开的花朵', 'blooming flowers'],
  ['花束', 'a bouquet'],
  ['盆栽', 'a potted plant'],
  ['窗边的绿植', 'a plant by the window'],
  ['树', 'a tree'],
  ['书', 'books'],
  ['相机', 'a camera'],
  ['手机', 'a smartphone'],
  ['笔记本电脑', 'a laptop'],
  ['键盘', 'a keyboard'],
  ['吉他', 'a guitar'],
  ['钢琴', 'a piano'],
  ['小提琴', 'a violin'],
  ['自行车', 'a bicycle'],
  ['汽车', 'a car'],
  ['摩托车', 'a motorcycle'],
  ['船', 'a boat'],
  ['飞机', 'an airplane'],
  ['火车', 'a train'],
  ['气球', 'balloons'],
  ['蜡烛', 'candles'],
  ['灯笼', 'a lantern'],
  ['烟花', 'fireworks'],
  ['玩具', 'a toy'],
  ['镜子', 'a mirror'],
  ['窗帘', 'curtains'],
  ['台灯', 'a desk lamp'],
  ['时钟', 'a clock'],
  ['杯子', 'a cup'],
  ['瓶子', 'a bottle'],
  ['花盆', 'a flowerpot'],

  // ---------- 室内场景 ----------
  ['卧室', 'a bedroom'],
  ['厨房', 'a kitchen'],
  ['书房', 'a study room'],
  ['客厅', 'a living room'],
  ['教室', 'a classroom'],
  ['图书馆', 'a library'],
  ['健身房', 'a gym'],
  ['后台', 'backstage'],
  ['化妆间', 'a dressing room'],
  ['浴室', 'a bathroom'],
  ['楼梯间', 'a stairwell'],
  ['阳台', 'a balcony'],

  // ---------- 色调与节日 ----------
  ['红色', 'red'],
  ['蓝色', 'blue'],
  ['绿色', 'green'],
  ['黄色', 'yellow'],
  ['粉色', 'pink'],
  ['紫色', 'purple'],
  ['白色', 'white'],
  ['黑色', 'black'],
  ['金色', 'gold'],
  ['圣诞', 'Christmas'],
  ['万圣节', 'Halloween'],
  ['新年', 'New Year'],
  ['灯笼夜景', 'a night scene with lanterns'],
];

/** 预选词的中文 / 英文两版。`lang` 不是 `en` 就回中文。 */
function labelsFor(lang) {
  const english = String(lang || '')
    .toLowerCase()
    .startsWith('en');
  return TERMS.map((pair) => (english ? pair[1] : pair[0]));
}

/**
 * 预选词的**条数上限与下限，唯一定义处**。
 *
 * ⚠️ 这两组数现在被**两份实现**引用：
 *   · `src/main/semantic-tags.js#SemanticTags.suggestTerms` —— 主进程只读 SQL（常规路径）；
 *   · `src/workers/semantic-worker.js#readOnly` 的 `suggest` 分支 —— 老契约（给一组指定的词打分）。
 * 两边各写一份的后果不是报错，而是**同一个界面元素在被两条路服务时给出不同条数**，
 * 而界面只摆 5 个（`SUGGEST_COUNT`），差 24 还是 64 在界面上**看不出来** —— 静默分叉。
 */
const SUGGEST_LIMIT_DEFAULT = 24;
const SUGGEST_LIMIT_MAX = 64;

module.exports = { TERMS, labelsFor, SUGGEST_LIMIT_DEFAULT, SUGGEST_LIMIT_MAX };
