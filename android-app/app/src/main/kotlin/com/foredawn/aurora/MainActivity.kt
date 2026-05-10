package com.foredawn.aurora

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.*
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.foredawn.aurora.data.api.ApiClient
import com.foredawn.aurora.data.local.SettingsStore
import com.foredawn.aurora.data.repository.PhotoRepository
import com.foredawn.aurora.ui.screens.*
import com.foredawn.aurora.ui.theme.AuroraGalleryTheme
import com.foredawn.aurora.ui.viewmodel.BrowseViewModel
import com.foredawn.aurora.ui.viewmodel.LoginViewModel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val settingsStore = (application as AuroraApplication).settingsStore

        setContent {
            AuroraGalleryTheme {
                var serverUrl by remember { mutableStateOf<String?>(null) }
                var isChecking by remember { mutableStateOf(true) }
                val scope = rememberCoroutineScope()

                // Load saved server URL
                LaunchedEffect(Unit) {
                    settingsStore.serverUrl.collect { savedUrl ->
                        if (!isChecking) return@collect
                        if (savedUrl != null) {
                            // Try a quick ping
                            val api = ApiClient.create(savedUrl)
                            try {
                                api.getStats()
                                serverUrl = savedUrl
                            } catch (_: Exception) {
                                // Server offline, still show saved URL
                                serverUrl = savedUrl
                            }
                        }
                        isChecking = false
                    }
                }

                when {
                    isChecking -> {
                        // Show splash / loading
                        androidx.compose.material3.Surface(
                            modifier = androidx.compose.ui.Modifier.fillMaxSize()
                        ) {}
                    }
                    serverUrl == null -> {
                        ServerSetupScreen(
                            currentUrl = null,
                            onSave = { url ->
                                val api = ApiClient.create(url)
                                val success = try {
                                    api.getStats()
                                    settingsStore.saveServerUrl(url)
                                    true
                                } catch (_: Exception) {
                                    false
                                }
                                success
                            },
                            onTestSuccess = { url -> serverUrl = url }
                        )
                    }
                    else -> {
                        AuroraApp(baseUrl = serverUrl!!, settingsStore = settingsStore) {
                            serverUrl = null
                            ApiClient.cookieJar.clear()
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun AuroraApp(baseUrl: String, settingsStore: SettingsStore, onLogout: () -> Unit) {
    val navController = rememberNavController()
    val api = remember(baseUrl) { ApiClient.create(baseUrl) }
    val repository = remember(api) { PhotoRepository(api) }
    val loginViewModel: LoginViewModel = viewModel { LoginViewModel(repository) }
    val browseViewModel: BrowseViewModel = viewModel { BrowseViewModel(repository) }

    var isAuthenticated by remember { mutableStateOf(false) }

    NavHost(
        navController = navController,
        startDestination = if (isAuthenticated) "browse" else "login"
    ) {
        composable("login") {
            LoginScreen(
                viewModel = loginViewModel,
                onLoginSuccess = { isAuthenticated = true; navController.navigate("browse") { popUpTo("login") { inclusive = true } } }
            )
        }
        composable("browse") {
            BrowseScreen(
                baseUrl = baseUrl,
                viewModel = browseViewModel,
                onPhotoClick = { photo ->
                    val index = browseViewModel.photos.indexOf(photo)
                    if (index >= 0) {
                        navController.navigate("preview/$index")
                    }
                },
                onSettingsClick = {
                    navController.navigate("settings")
                }
            )
        }
        composable(
            "preview/{index}",
            arguments = listOf(navArgument("index") { type = NavType.IntType })
        ) { backStack ->
            val index = backStack.arguments?.getInt("index") ?: 0
            val photos = browseViewModel.photos.toList()
            if (photos.isNotEmpty()) {
                PhotoPreviewScreen(
                    baseUrl = baseUrl,
                    photos = photos,
                    initialIndex = index,
                    viewModel = browseViewModel,
                    onBack = { navController.popBackStack() },
                    onVideoClick = { photo ->
                        navController.navigate("video/${photo.id}")
                    }
                )
            }
        }
        composable(
            "video/{photoId}",
            arguments = listOf(navArgument("photoId") { type = NavType.LongType })
        ) { backStack ->
            val photoId = backStack.arguments?.getLong("photoId") ?: 0L
            val photo = browseViewModel.photos.find { it.id == photoId }
            if (photo != null) {
                VideoPlayerScreen(
                    baseUrl = baseUrl,
                    photo = photo,
                    viewModel = browseViewModel,
                    onBack = { navController.popBackStack() }
                )
            }
        }
        composable("settings") {
            SettingsScreen(
                baseUrl = baseUrl,
                onClearServer = {
                    kotlinx.coroutines.runBlocking { settingsStore.clear() }
                    ApiClient.cookieJar.clear()
                    onLogout()
                },
                onBack = { navController.popBackStack() }
            )
        }
    }
}
