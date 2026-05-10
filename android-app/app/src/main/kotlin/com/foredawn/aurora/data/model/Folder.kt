package com.foredawn.aurora.data.model

import com.google.gson.annotations.SerializedName

data class Folder(
    val id: Int,
    val path: String,
    val name: String,
    @SerializedName("photo_count") val photoCount: Int,
    @SerializedName("folder_count") val folderCount: Int,
    @SerializedName("video_count") val videoCount: Int
)

data class FolderTreeEntry(
    @SerializedName("folder_path") val folderPath: String,
    @SerializedName("photo_count") val photoCount: Int,
    @SerializedName("earliest_date") val earliestDate: String?,
    @SerializedName("latest_date") val latestDate: String?
)

data class DateGroup(
    val date: String,
    val count: Int
)

data class Stats(
    @SerializedName("totalPhotos") val totalPhotos: Int,
    @SerializedName("totalSize") val totalSize: Long,
    @SerializedName("videoPhotos") val videoPhotos: Int,
    @SerializedName("totalFolders") val totalFolders: Int,
    @SerializedName("totalRoots") val totalRoots: Int,
    @SerializedName("favoritePhotos") val favoritePhotos: Int,
    @SerializedName("earliestDate") val earliestDate: String?,
    @SerializedName("latestDate") val latestDate: String?
)
