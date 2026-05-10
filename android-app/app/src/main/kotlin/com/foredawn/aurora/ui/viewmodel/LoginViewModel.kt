package com.foredawn.aurora.ui.viewmodel

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.foredawn.aurora.data.repository.PhotoRepository
import kotlinx.coroutines.launch

class LoginViewModel(private val repository: PhotoRepository) : ViewModel() {
    var isLoading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var isLoggedIn by mutableStateOf(false)
        private set

    fun login(password: String, onSuccess: () -> Unit) {
        viewModelScope.launch {
            isLoading = true
            error = null
            repository.login(password)
                .onSuccess {
                    isLoggedIn = true
                    onSuccess()
                }
                .onFailure {
                    error = it.message ?: "登录失败"
                }
            isLoading = false
        }
    }
}
