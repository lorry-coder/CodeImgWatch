/**
 * Sample program for testing Image Watch extension
 *
 * Build with OpenCV:
 *   g++ -g -o test_opencv test_opencv.cpp `pkg-config --cflags --libs opencv4`
 *
 * Or on Windows with MSVC:
 *   cl /Zi /EHsc test_opencv.cpp /I <opencv_include_path> /link <opencv_libs>
 */

#include <opencv2/opencv.hpp>
#include <iostream>

int main() {
    // CV_8UC1 - Grayscale
    cv::Mat gray = cv::Mat::zeros(100, 100, CV_8UC1);
    for (int y = 0; y < gray.rows; y++) {
        for (int x = 0; x < gray.cols; x++) {
            gray.at<uchar>(y, x) = static_cast<uchar>((x + y) % 256);
        }
    }

    // CV_8UC3 - BGR Color
    cv::Mat color = cv::Mat::zeros(100, 100, CV_8UC3);
    for (int y = 0; y < color.rows; y++) {
        for (int x = 0; x < color.cols; x++) {
            color.at<cv::Vec3b>(y, x) = cv::Vec3b(
                static_cast<uchar>(x * 2),     // Blue
                static_cast<uchar>(y * 2),     // Green
                static_cast<uchar>(255 - x)    // Red
            );
        }
    }

    // CV_32FC1 - Single channel float
    cv::Mat floatImg = cv::Mat::zeros(100, 100, CV_32FC1);
    for (int y = 0; y < floatImg.rows; y++) {
        for (int x = 0; x < floatImg.cols; x++) {
            floatImg.at<float>(y, x) = static_cast<float>(x + y) / 200.0f;
        }
    }

    // CV_8UC4 - BGRA with alpha
    cv::Mat rgba = cv::Mat::zeros(100, 100, CV_8UC4);
    for (int y = 0; y < rgba.rows; y++) {
        for (int x = 0; x < rgba.cols; x++) {
            rgba.at<cv::Vec4b>(y, x) = cv::Vec4b(
                static_cast<uchar>(x * 2),
                static_cast<uchar>(y * 2),
                static_cast<uchar>(128),
                static_cast<uchar>(x + y)  // Alpha varies
            );
        }
    }

    // cv::Mat_<T> - Typed matrix
    cv::Mat_<cv::Vec3b> typedColor(100, 100);
    for (int y = 0; y < typedColor.rows; y++) {
        for (int x = 0; x < typedColor.cols; x++) {
            typedColor(y, x) = cv::Vec3b(255 - x, x, y);
        }
    }

    // Array of images
    std::vector<cv::Mat> images;
    images.push_back(gray.clone());
    images.push_back(color.clone());
    images.push_back(floatImg.clone());

    // Pointer to image
    cv::Mat* pImage = &color;

    // Small matrix (cv::Matx)
    cv::Matx33f rotation = cv::Matx33f::eye();

    // Vector
    cv::Vec3f vec3(1.0f, 2.0f, 3.0f);
    cv::Vec4b vec4b(10, 20, 30, 40);

    // ROI (Region of Interest) - non-continuous
    cv::Mat roi = color(cv::Rect(10, 10, 50, 50));

    // Set breakpoint here to test Image Watch
    std::cout << "Breakpoint here to inspect images" << std::endl;
    std::cout << "gray: " << gray.size() << " type: " << gray.type() << std::endl;
    std::cout << "color: " << color.size() << " type: " << color.type() << std::endl;
    std::cout << "floatImg: " << floatImg.size() << " type: " << floatImg.type() << std::endl;
    std::cout << "rgba: " << rgba.size() << " type: " << rgba.type() << std::endl;
    std::cout << "roi: " << roi.size() << " continuous: " << roi.isContinuous() << std::endl;

    // Modify and observe changes
    cv::circle(color, cv::Point(50, 50), 20, cv::Scalar(0, 255, 0), -1);
    std::cout << "After drawing circle" << std::endl;

    // Another breakpoint location
    cv::rectangle(color, cv::Point(20, 20), cv::Point(80, 80), cv::Scalar(255, 0, 0), 2);
    std::cout << "After drawing rectangle" << std::endl;

    return 0;
}
