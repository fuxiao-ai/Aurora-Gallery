package com.foredawn.aurora.data.model

import com.google.gson.annotations.SerializedName

data class Photo(
    val id: Long,
    @SerializedName("file_name") val fileName: String,
    @SerializedName("folder_path") val folderPath: String,
    @SerializedName("file_size") val fileSize: Long,
    @SerializedName("file_type") val fileType: String,
    val width: Int?,
    val height: Int?,
    @SerializedName("date_taken") val dateTaken: String?,
    @SerializedName("date_modified") val dateModified: String?,
    @SerializedName("has_thumbnail") val hasThumbnail: Int,
    @SerializedName("is_favorite") val isFavorite: Int,
    // 缩略图规格（2026-10-07 加）。浏览端需要它来拼缓存键：缩略图重建（换档 / 转 WebP）
    // **不动原图**，所以只按 file_size + date_modified 拼出来的 URL 在重建前后完全一样，
    // 而 `/thumb/:id` 是 `Cache-Control: public, max-age=86400` ⇒ 重建跑完了，
    // 手机上还要再看一天旧档位的图。可空：老服务端 / 老接口不带这两列。
    @SerializedName("thumb_size") val thumbSize: Int? = null,
    @SerializedName("thumb_format") val thumbFormat: String? = null
) {
    /**
     * 缩略图 URL。`?v=` 里**带这一行自己的规格**，与服务端 `#thumbCacheVersion` 同一套公式：
     * `<file_size><date_modified 的数字>-<档位><格式>`。
     *
     * ⚠️ 与网页端 / 桌面端不共享代码（三端各一份），改公式要三处一起改。
     *    这里不做「公式必须一致」的硬约束 —— 键只影响缓存命中，不影响正确性；
     *    但它必须**随规格变化**，否则重建在这端等于不生效。
     */
    fun thumbnailUrl(baseUrl: String): String {
        val base = fileSize.toString() + (dateModified ?: "").filter { it.isDigit() }
        val size = thumbSize ?: 0
        val format = (thumbFormat ?: "").lowercase().filter { it in 'a'..'z' }
        return "$baseUrl/thumb/$id?v=$base-$size$format"
    }

    fun previewUrl(baseUrl: String): String = "$baseUrl/preview-image/$id"
    fun originalUrl(baseUrl: String): String = "$baseUrl/photo/$id"
    fun isVideo(): Boolean {
        val t = fileType.lowercase()
        return listOf("mp4", "mov", "m4v", "mkv", "avi", "wmv", "webm", "flv", "mpg", "mpeg", "m2ts", "ts", "3gp", "3g2").contains(t)
    }
}

data class PaginatedPhotos(
    val photos: List<Photo>,
    val total: Int,
    val page: Int,
    @SerializedName("pageSize") val pageSize: Int,
    @SerializedName("totalPages") val totalPages: Int
)

data class PhotoInfo(
    val id: Long,
    @SerializedName("file_path") val filePath: String,
    @SerializedName("file_name") val fileName: String,
    @SerializedName("file_size") val fileSize: Long,
    @SerializedName("file_type") val fileType: String,
    val width: Int?,
    val height: Int?,
    @SerializedName("date_taken") val dateTaken: String?,
    @SerializedName("date_modified") val dateModified: String?,
    @SerializedName("is_favorite") val isFavorite: Int,
    @SerializedName("camera_make") val cameraMake: String?,
    @SerializedName("camera_model") val cameraModel: String?,
    @SerializedName("lens_model") val lensModel: String?,
    @SerializedName("focal_length") val focalLength: Double?,
    val aperture: Double?,
    @SerializedName("iso_speed") val isoSpeed: Int?,
    @SerializedName("shutter_speed") val shutterSpeed: String?,
    @SerializedName("gps_latitude") val gpsLatitude: Double?,
    @SerializedName("gps_longitude") val gpsLongitude: Double?
)
