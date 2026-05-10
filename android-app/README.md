# 拂晓图库 Android 客户端

一个简单的 Android 客户端，兼容手机和平板，用于连接桌面端的拂晓图库局域网服务。

## 功能

- 浏览照片和视频（支持瀑布流网格）
- 按文件夹、日期查看照片
- 搜索照片
- 收藏功能
- 大图预览（双击缩放）
- 视频播放（支持 HLS 转码和直传）
- 平板自适应布局（侧边导航 + 双栏）

## 环境要求

- Android Studio Ladybug (2024.2.1) 或更新版本
- JDK 17
- Android SDK 35

## 如何运行

1. 用 Android Studio 打开 `android-app` 文件夹
2. 等待 Gradle Sync 完成
3. 连接手机或启动模拟器
4. 点击 Run

## 使用方式

1. 确保桌面端拂晓图库已开启「局域网访问」
2. 在手机端输入服务器地址，例如 `http://192.168.1.5:3456/`
3. 输入访问密码（桌面端 管理 → 局域网访问 中查看）
4. 开始浏览照片

## 技术栈

- Kotlin + Jetpack Compose
- Material3 + 自适应布局
- Retrofit2 + OkHttp3
- Coil（图片加载）
- ExoPlayer（视频播放）
- DataStore（本地配置）
