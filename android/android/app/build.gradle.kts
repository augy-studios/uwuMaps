import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Signing from android/keystore.properties and android/android.keystore, only when present, so a fresh
// checkout still builds debug. Neither is ever committed, and both must be backed up: a different key
// can't update installed apps.
val keystoreProps = Properties()
val keystoreFile = rootProject.file("../keystore.properties")
if (keystoreFile.exists()) keystoreFile.inputStream().use { keystoreProps.load(it) }

android {
    namespace = "org.uwuapps.uwumaps"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "org.uwuapps.uwumaps"
        minSdk = 24 // Android 7.0
        targetSdk = flutter.targetSdkVersion
        // Both from pubspec.yaml's version: a phone only takes a higher versionCode.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            if (keystoreProps.getProperty("storeFile") != null) {
                storeFile = rootProject.file("../" + keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    // Native libraries compressed in the APK, rather than stored as they are: the APK is committed to git,
    // where GitHub takes nothing over 100 MB, and it's what everybody downloads. Android unpacks them on
    // install, so this costs some room on the phone rather than on the way there.
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    buildTypes {
        release {
            // Plugins reach much of their Java by reflection and from native code, and a stripped class
            // would only show up at runtime, so nothing's removed.
            isMinifyEnabled = false
            isShrinkResources = false
            if (keystoreProps.getProperty("storeFile") != null) signingConfig = signingConfigs.getByName("release")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
