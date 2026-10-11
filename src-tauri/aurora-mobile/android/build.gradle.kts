import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.aurora.mobile"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

val media3 = "1.11.1"

dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.core:core-ktx:1.13.1")
    // ActivityResult, for the picture / backup file pickers.
    implementation("androidx.activity:activity-ktx:1.10.1")
    // Playback service: background play, lock screen, Bluetooth controls, Android Auto.
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-session:$media3")
    implementation("com.google.guava:guava:33.3.1-android")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Search + stream extraction for YouTube and SoundCloud (the NewPipe app's library), from JitPack.
    implementation("com.github.teamnewpipe:NewPipeExtractor:v0.26.5")
}
