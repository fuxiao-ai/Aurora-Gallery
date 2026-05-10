package com.foredawn.aurora.data.api

import com.foredawn.aurora.data.model.*
import retrofit2.Response
import retrofit2.http.*

interface AuroraApi {
    @POST("api/login")
    suspend fun login(@Body request: LoginRequest): Response<Unit>

    @GET("api/stats")
    suspend fun getStats(): Stats

    @GET("api/photos")
    suspend fun getPhotos(
        @Query("page") page: Int,
        @Query("pageSize") pageSize: Int = 72,
        @Query("sortBy") sortBy: String = "date_taken",
        @Query("sortOrder") sortOrder: String = "DESC",
        @Query("mediaType") mediaType: String = "all",
        @Query("favoritesOnly") favoritesOnly: Boolean = false
    ): PaginatedPhotos

    @GET("api/folder-photos")
    suspend fun getFolderPhotos(
        @Query("path") path: String,
        @Query("page") page: Int,
        @Query("pageSize") pageSize: Int = 72,
        @Query("sortBy") sortBy: String = "date_taken",
        @Query("sortOrder") sortOrder: String = "DESC",
        @Query("mediaType") mediaType: String = "all",
        @Query("includeSubfolders") includeSubfolders: Boolean = true,
        @Query("favoritesOnly") favoritesOnly: Boolean = false
    ): PaginatedPhotos

    @GET("api/date-photos")
    suspend fun getDatePhotos(
        @Query("date") date: String,
        @Query("page") page: Int,
        @Query("pageSize") pageSize: Int = 72,
        @Query("sortBy") sortBy: String = "date_taken",
        @Query("sortOrder") sortOrder: String = "DESC",
        @Query("mediaType") mediaType: String = "all",
        @Query("favoritesOnly") favoritesOnly: Boolean = false
    ): PaginatedPhotos

    @GET("api/search")
    suspend fun search(
        @Query("q") query: String,
        @Query("page") page: Int,
        @Query("pageSize") pageSize: Int = 72,
        @Query("mediaType") mediaType: String = "all",
        @Query("favoritesOnly") favoritesOnly: Boolean = false
    ): PaginatedPhotos

    @GET("api/root-folders")
    suspend fun getRootFolders(): List<Folder>

    @GET("api/folder-tree")
    suspend fun getFolderTree(@Query("rootId") rootId: Int): List<FolderTreeEntry>

    @GET("api/date-groups")
    suspend fun getDateGroups(
        @Query("sortOrder") sortOrder: String = "desc"
    ): List<DateGroup>

    @POST("api/toggle-favorite")
    suspend fun toggleFavorite(@Body request: FavoriteRequest): FavoriteResponse

    @GET("api/photo-info")
    suspend fun getPhotoInfo(@Query("id") id: Long): PhotoInfo

    @GET("api/video-playback")
    suspend fun getVideoPlayback(@Query("id") id: Long): VideoPlayback

    @GET("api/video-subtitle")
    suspend fun getSubtitle(@Query("id") id: Long): Response<String>
}
