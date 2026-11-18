plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "it.brondomiki.portafoglio"
    compileSdk = 34

    defaultConfig {
        applicationId = "it.brondomiki.portafoglio"
        minSdk = 26
        targetSdk = 34
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
    }

    // chiave fissa: gli aggiornamenti si installano sopra la versione precedente
    signingConfigs {
        create("shared") {
            storeFile = file("../keystore/portafoglio.jks")
            storePassword = "portafoglio"
            keyAlias = "portafoglio"
            keyPassword = "portafoglio"
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
        }
        getByName("debug") {
            signingConfig = signingConfigs.getByName("shared")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-session:1.4.1")
    implementation("androidx.core:core-ktx:1.13.1")
}
