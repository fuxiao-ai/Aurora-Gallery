package com.foredawn.aurora.data.repository

import com.foredawn.aurora.data.api.AuroraApi
import com.foredawn.aurora.data.model.*

class PhotoRepository(private val api: AuroraApi) {
    suspend fun login(password: String): Result<Unit> = runCatching {
        val response = api.login(LoginRequest(password))
        if (!response.isSuccessful) throw Exception("登录失败: ${response.code()}")
    }

    suspend fun getStats(): Result<Stats> = runCatching { api.getStats() }

    suspend fun getPhotos(page: Int, pageSize: Int = 72, favoritesOnly: Boolean = false): Result<PaginatedPhotos> =
        runCatching { api.getPhotos(page, pageSize, favoritesOnly = favoritesOnly) }

    suspend fun getFolderPhotos(path: String, page: Int, pageSize: Int = 72, favoritesOnly: Boolean = false): Result<PaginatedPhotos> =
        runCatching { api.getFolderPhotos(path, page, pageSize, favoritesOnly = favoritesOnly) }

    suspend fun getDatePhotos(date: String, page: Int, pageSize: Int = 72, favoritesOnly: Boolean = false): Result<PaginatedPhotos> =
        runCatching { api.getDatePhotos(date, page, pageSize, favoritesOnly = favoritesOnly) }

    suspend fun search(query: String, page: Int, pageSize: Int = 72, favoritesOnly: Boolean = false): Result<PaginatedPhotos> =
        runCatching { api.search(query, page, pageSize, favoritesOnly = favoritesOnly) }

    suspend fun getRootFolders(): Result<List<Folder>> = runCatching { api.getRootFolders() }

    suspend fun getFolderTree(rootId: Int): Result<List<FolderTreeEntry>> =
        runCatching { api.getFolderTree(rootId) }

    suspend fun getDateGroups(): Result<List<DateGroup>> = runCatching { api.getDateGroups() }

    suspend fun toggleFavorite(id: Long): Result<Boolean> = runCatching {
        api.toggleFavorite(FavoriteRequest(id)).isFavorite == 1
    }

    suspend fun getPhotoInfo(id: Long): Result<PhotoInfo> = runCatching { api.getPhotoInfo(id) }

    suspend fun getVideoPlayback(id: Long): Result<VideoPlayback> =
        runCatching { api.getVideoPlayback(id) }
}
