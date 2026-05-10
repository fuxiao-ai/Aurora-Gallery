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
    @SerializedName("is_favorite") val isFavorite: Int
) {
    fun thumbnailUrl(baseUrl: String): String = "$baseUrl/thumb/$id"
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
