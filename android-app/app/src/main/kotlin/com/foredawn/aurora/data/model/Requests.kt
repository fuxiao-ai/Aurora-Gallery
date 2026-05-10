package com.foredawn.aurora.data.model

import com.google.gson.annotations.SerializedName

data class LoginRequest(
    val password: String
)

data class FavoriteRequest(
    val id: Long
)

data class FavoriteResponse(
    @SerializedName("is_favorite") val isFavorite: Int
)
